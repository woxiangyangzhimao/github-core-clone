// Git objects, packs and the smart-HTTP protocol, on the Node standard library only.
// No git binary, no dependency: SHA-1 from node:crypto, compression from node:zlib.
// The wire shapes follow git's Documentation/technical/protocol-v2.txt and
// http-protocol.txt: pkt-lines, the v2 capability advertisement, ls-refs, fetch and
// the v0 receive-pack with report-status and side-band-64k.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export const OBJ_TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const OBJ_CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** SHA-1 of a git object: sha1("<type> <size>\0" + data). */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** The canonical loose-object header for a stored object. */
export function objectHeader(type: ObjType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]);
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex digits of the total length, then the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** A pkt-line reader over a Buffer: yields payloads; '0000' yields null (flush). */
export class PktReader {
  private pos = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  /** Read one pkt-line payload, or null on flush, or undefined at end of input. */
  read(): Buffer | null | undefined {
    if (this.pos + 4 > this.buf.length) return undefined;
    const len = parseInt(this.buf.subarray(this.pos, this.pos + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) return undefined;
    if (len === 0) {
      this.pos += 4;
      return null;
    }
    if (len === 1) {
      // A delim packet (0001) separates sections; skip it and read on.
      this.pos += 4;
      return this.read();
    }
    if (len < 4 || this.pos + len > this.buf.length) return undefined;
    const payload = this.buf.subarray(this.pos + 4, this.pos + len);
    this.pos += len;
    return payload;
  }

  /** Read raw bytes (used for the packfile body after its section header). */
  readRaw(n: number): Buffer | undefined {
    if (this.pos + n > this.buf.length) return undefined;
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

// ---------------------------------------------------------------- objects

export interface CommitObject {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a commit object's raw bytes. */
export function parseCommit(data: Buffer): CommitObject {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: data };
}

/** Serialize a commit object from its parts. */
export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse a tree object's raw bytes into entries (mode, name, sha). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    pos = nul + 21;
  }
  return entries;
}

/** Serialize tree entries. Entries must be sorted the way git sorts them (by name, with directories as if they ended in '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A minimal in-memory object store: sha -> {type, data}. */
export class ObjectStore {
  readonly objects = new Map<string, { type: ObjType; data: Buffer }>();

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  read(sha: string): { type: ObjType; data: Buffer } | undefined {
    return this.objects.get(sha);
  }

  /** Store an object, returning its sha. */
  write(type: ObjType, data: Buffer): string {
    const sha = hashObject(type, data);
    this.objects.set(sha, { type, data });
    return sha;
  }

  /** Store an object under a known sha (used when unpacking a pack). */
  put(sha: string, type: ObjType, data: Buffer): void {
    this.objects.set(sha, { type, data });
  }

  /** All commit ancestors of `tip` (including tip itself), newest-first by walk order. */
  ancestors(tip: string): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      const obj = this.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      seen.add(sha);
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return seen;
  }

  /** True when `ancestor` is an ancestor of (or equal to) `tip`. */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    return this.ancestors(tip).has(ancestor);
  }
}

// ---------------------------------------------------------------- packfiles

/** Encode one object's type+size header the way a pack entry stores it. */
function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeCode << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) b |= 0x80;
  bytes.push(b);
  while (size > 0) {
    b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/**
 * Every object the client already holds: the full closure of its `haves`
 * (commit, its tree and blobs), descending to parents except past a shallow
 * boundary commit, whose own tree/blobs the client has but whose parents it
 * does not. `requestShallow` is the set of shallow boundaries the client
 * reported in this fetch.
 */
function heldClosure(
  store: ObjectStore,
  haves: Iterable<string>,
  requestShallow: ReadonlySet<string>,
): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [...haves];
  const seen = new Set<string>();
  const addTree = (treeSha: string): void => {
    const stack = [treeSha];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (held.has(sha)) continue;
      const obj = store.read(sha);
      if (obj === undefined || obj.type !== 'tree') continue;
      held.add(sha);
      for (const e of parseTree(obj.data)) {
        if (e.mode === '40000') stack.push(e.sha);
        else held.add(e.sha);
      }
    }
  };
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.read(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    held.add(sha);
    addTree(parseCommit(obj.data).tree);
    if (requestShallow.has(sha)) continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return held;
}

/**
 * Collect every object reachable from `tips`, excluding anything the client
 * already holds. With `shallowDepth` set, the walk stops at that depth from
 * each tip: commits at depth `shallowDepth - 1` are the new shallow boundary
 * (their parents are not fetched), and boundaries the client reported that
 * now have a fetched parent are returned as `unshallow`.
 * Objects come back in an order a client accepts: commits first
 * (topological), then trees, then blobs.
 */
export function collectForPack(
  store: ObjectStore,
  tips: string[],
  haves: Set<string>,
  shallowDepth: number | undefined,
  requestShallow: ReadonlySet<string> = new Set(),
): { objects: { sha: string; type: ObjType; data: Buffer }[]; shallow: string[]; unshallow: string[] } {
  const held = heldClosure(store, haves, requestShallow);
  const wanted = new Set<string>();
  // Commits in the fetched history (wanted or already held), with their depth
  // from the nearest tip; used to find the new shallow boundary.
  const included = new Map<string, number>();
  const shallow = new Set<string>();
  // Walk commits breadth-first from the tips, respecting the depth cap. Held
  // commits are not re-sent, but the walk descends through them: a shallow
  // client holds the tip yet not its parents, and a deepen must reach past it.
  const queue: { sha: string; depth: number }[] = tips.map((sha) => ({ sha, depth: 0 }));
  const seenCommit = new Set<string>();
  while (queue.length > 0) {
    const { sha, depth } = queue.shift() as { sha: string; depth: number };
    if (seenCommit.has(sha)) continue;
    const obj = store.read(sha);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      // A tag tip is fetched as an object; its target joins the walk at the
      // same depth (a tag may point at another tag).
      seenCommit.add(sha);
      if (!held.has(sha)) wanted.add(sha);
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m !== null) queue.push({ sha: m[1] as string, depth });
      continue;
    }
    if (obj.type !== 'commit') continue;
    seenCommit.add(sha);
    if (shallowDepth !== undefined && depth >= shallowDepth) {
      // Beyond the cap: not fetched, not a boundary, just absent.
      continue;
    }
    if (!included.has(sha) || (included.get(sha) as number) > depth) included.set(sha, depth);
    if (!held.has(sha)) wanted.add(sha);
    for (const p of parseCommit(obj.data).parents) queue.push({ sha: p, depth: depth + 1 });
  }
  if (shallowDepth !== undefined) {
    for (const [sha, depth] of included) {
      if (depth === shallowDepth - 1) shallow.add(sha);
    }
  }
  // A reported boundary is unshallowed when its parent is now in the history.
  const unshallow = new Set<string>();
  for (const b of requestShallow) {
    if (!included.has(b)) continue;
    const obj = store.read(b);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (included.has(p)) { unshallow.add(b); break; }
    }
  }
  // Trees and blobs reachable from the wanted commits (not from shallow ones),
  // excluding anything the client already holds.
  const trees = new Set<string>();
  const blobs = new Set<string>();
  const walkTree = (sha: string): void => {
    if (trees.has(sha) || held.has(sha)) return;
    const obj = store.read(sha);
    if (obj === undefined || obj.type !== 'tree') return;
    trees.add(sha);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walkTree(e.sha);
      else if (!held.has(e.sha)) blobs.add(e.sha);
    }
  };
  for (const sha of wanted) {
    const obj = store.read(sha);
    if (obj !== undefined && obj.type === 'commit') walkTree(parseCommit(obj.data).tree);
  }
  const objects: { sha: string; type: ObjType; data: Buffer }[] = [];
  for (const sha of wanted) {
    const o = store.read(sha) as { type: ObjType; data: Buffer };
    objects.push({ sha, type: o.type, data: o.data });
  }
  for (const sha of trees) {
    const o = store.read(sha) as { type: ObjType; data: Buffer };
    objects.push({ sha, type: 'tree', data: o.data });
  }
  for (const sha of blobs) {
    const o = store.read(sha) as { type: ObjType; data: Buffer };
    objects.push({ sha, type: 'blob', data: o.data });
  }
  return { objects, shallow: [...shallow], unshallow: [...unshallow] };
}

/** Serialize objects as a packfile (v2): no deltas, every object whole. */
export function buildPack(objects: { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    const typeCode = OBJ_TYPE_CODE[o.type];
    const compressed = deflateSync(o.data, { level: 6 });
    parts.push(packObjectHeader(typeCode, o.data.length), compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- delta application

/** Read a delta's size varint (little-endian base-128). Returns [value, bytesRead]. */
function readDeltaVarint(buf: Buffer, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    const b = buf[i] as number;
    value |= (b & 0x7f) << shift;
    shift += 7;
    i += 1;
    if ((b & 0x80) === 0) break;
  }
  return [value, i - pos];
}

/**
 * Apply a delta to its base, following git's delta format: copy commands (high
 * bit set) take offset/size bytes, insert commands (low 7 bits) take that many
 * literal bytes.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const [sourceSize, n1] = readDeltaVarint(delta, pos);
  pos += n1;
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const [targetSize, n2] = readDeltaVarint(delta, pos);
  pos += n2;
  const out: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) { offset = delta[pos] as number; pos += 1; }
      if ((op & 0x02) !== 0) { offset |= (delta[pos] as number) << 8; pos += 1; }
      if ((op & 0x04) !== 0) { offset |= (delta[pos] as number) << 16; pos += 1; }
      if ((op & 0x08) !== 0) { offset |= (delta[pos] as number) << 24; pos += 1; }
      if ((op & 0x10) !== 0) { size = delta[pos] as number; pos += 1; }
      if ((op & 0x20) !== 0) { size |= (delta[pos] as number) << 8; pos += 1; }
      if ((op & 0x40) !== 0) { size |= (delta[pos] as number) << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/** Read a pack entry's type+size header. Returns [typeCode, size, bytesRead]. */
function readPackEntryHeader(buf: Buffer, pos: number): [number, number, number] {
  let b = buf[pos] as number;
  const typeCode = (b >> 4) & 0x07;
  let size = b & 0x0f;
  let shift = 4;
  let i = pos + 1;
  while ((b & 0x80) !== 0) {
    b = buf[i] as number;
    size |= (b & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return [typeCode, size, i - pos];
}

/**
 * Inflate exactly one zlib stream starting at `start`, ignoring any bytes after
 * the stream ends. inflateSync succeeds with trailing garbage but throws on a
 * truncated stream, so the stream's end is the smallest length that succeeds:
 * binary search for it. Returns the inflated data and the offset just past the
 * stream.
 */
export function inflateBounded(buf: Buffer, start: number): { data: Buffer; end: number } {
  let lo = 1;
  let hi = buf.length - start;
  // The stream must end somewhere in (start, buf.length]; find the smallest
  // length that inflates cleanly.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(start, start + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(buf.subarray(start, start + lo));
  return { data, end: start + lo };
}

/**
 * Parse a whole packfile into objects, resolving OFS_DELTA (type 6) and
 * REF_DELTA (type 7) entries. Thin-pack bases may live in `store` already;
 * every parsed object is written into `store` and returned with its sha.
 */
export function unpackPack(store: ObjectStore, pack: Buffer): { sha: string; type: ObjType }[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  interface Whole { type: ObjType; data: Buffer; sha: string }
  interface DeltaRec { baseOfs: number; baseSha: string; delta: Buffer }
  const byOffset = new Map<number, Whole | DeltaRec>();
  const bySha = new Map<string, Whole>();
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    const [typeCode, _size, headerLen] = readPackEntryHeader(pack, pos);
    pos += headerLen;
    if (typeCode >= 1 && typeCode <= 4) {
      const type = OBJ_CODE_TYPE[typeCode] as ObjType;
      const { data, end } = inflateBounded(pack, pos);
      pos = end;
      const sha = hashObject(type, data);
      const whole: Whole = { type, data, sha };
      byOffset.set(start, whole);
      bySha.set(sha, whole);
    } else if (typeCode === 6) {
      // OFS_DELTA: offset back from this entry's start.
      let b = pack[pos] as number;
      pos += 1;
      let offset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      const { data: delta, end } = inflateBounded(pack, pos);
      pos = end;
      byOffset.set(start, { baseOfs: start - offset, baseSha: '', delta });
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base sha follows the header.
      const baseSha = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { data: delta, end } = inflateBounded(pack, pos);
      pos = end;
      byOffset.set(start, { baseOfs: -1, baseSha, delta });
    } else {
      throw new Error(`unknown pack entry type ${typeCode}`);
    }
  }
  // Resolve deltas (a delta's base may itself be a delta) with memoization.
  const resolve = (rec: Whole | DeltaRec): Whole => {
    if ('data' in rec) return rec;
    let base: Whole | undefined;
    if (rec.baseOfs >= 0) {
      const baseRec = byOffset.get(rec.baseOfs);
      if (baseRec === undefined) throw new Error('delta base offset not in pack');
      base = resolve(baseRec);
    } else {
      base = bySha.get(rec.baseSha) ?? undefined;
      if (base === undefined) {
        const existing = store.read(rec.baseSha);
        if (existing === undefined) throw new Error('thin-pack base not in store');
        base = { type: existing.type, data: existing.data, sha: rec.baseSha };
      }
    }
    const data = applyDelta(base.data, rec.delta);
    const whole: Whole = { type: base.type, data, sha: hashObject(base.type, data) };
    bySha.set(whole.sha, whole);
    return whole;
  };
  const out: { sha: string; type: ObjType }[] = [];
  for (const rec of byOffset.values()) {
    const whole = resolve(rec);
    store.put(whole.sha, whole.type, whole.data);
    out.push({ sha: whole.sha, type: whole.type });
  }
  return out;
}

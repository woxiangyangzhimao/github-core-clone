// git smart HTTP: upload-pack (protocol v2 and v0) and receive-pack (v0), over the
// in-memory object store. No git binary anywhere: packs are built and read here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PktReader,
  ZERO_OID,
  buildPack,
  collectForPack,
  pktDelim,
  pktFlush,
  pktLine,
  unpackPack,
} from './git.ts';
import { headRefOf, type Repo, type Store } from './store.ts';

const UPLOAD_PACK = 'git-upload-pack';
const RECEIVE_PACK = 'git-receive-pack';

/** Read the whole request body into a Buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** All refs of a repo, HEAD first, then lexical: [refname, sha]. */
export function listRefs(repo: Repo): [string, string][] {
  const out: [string, string][] = [];
  const head = headRefOf(repo);
  if (head !== null) out.push(['HEAD', repo.refs.get(head) as string]);
  const names = [...repo.refs.keys()].sort();
  for (const name of names) out.push([name, repo.refs.get(name) as string]);
  return out;
}

/** The v0 advertisement for a service: preamble + flush + refs (+ capabilities). */
function advertiseV0(service: string, repo: Repo, capabilities: string[]): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = listRefs(repo);
  const caps = capabilities.length > 0 ? `\0${capabilities.join(' ')}` : '';
  if (refs.length === 0) {
    // An empty repository advertises the capabilities pseudo-ref, as git does.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}${caps}\n`));
  } else {
    refs.forEach(([name, sha], i) => {
      parts.push(pktLine(`${sha} ${name}${i === 0 ? caps : ''}\n`));
      // Annotated tags advertise a peeled line naming the commit they point at.
      if (name.startsWith('refs/tags/')) {
        const obj = repo.objects.read(sha);
        if (obj !== undefined && obj.type === 'tag') {
          const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
          if (m !== null) parts.push(pktLine(`${m[1]} ${name}^{}\n`));
        }
      }
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: "version 2" + capabilities + flush. */
function advertiseV2(): Buffer {
  const lines = [
    'version 2',
    'agent=forge/1.0',
    'ls-refs=unborn',
    'fetch=shallow',
    'object-format=sha1',
  ];
  const parts = lines.map((l) => pktLine(`${l}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  unborn: boolean;
  symrefs: boolean;
  prefixes: string[];
}

/**
 * Answer a v2 ls-refs command: ref lines, then flush. An unborn HEAD is
 * reported as a line whose first word is literally `unborn`; a peeled tag
 * carries its `peeled:` attribute on its own line.
 */
function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headTarget);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (keep('HEAD')) {
    if (headSha !== undefined) {
      const attrs = args.symrefs ? ` symref-target:${headTarget}` : '';
      parts.push(pktLine(`${headSha} HEAD${attrs}\n`));
    } else if (args.unborn) {
      const attrs = args.symrefs ? ` symref-target:${headTarget}` : '';
      parts.push(pktLine(`unborn HEAD${attrs}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!keep(name)) continue;
    const sha = repo.refs.get(name) as string;
    const attrs: string[] = [];
    if (args.peel && name.startsWith('refs/tags/')) {
      const obj = repo.objects.read(sha);
      if (obj !== undefined && obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (m !== null) attrs.push(`peeled:${m[1]}`);
      }
    }
    parts.push(pktLine(`${sha} ${name}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch (v2)

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | undefined;
}

/**
 * Answer a v2 fetch command: acknowledgment, shallow-info, packfile sections,
 * separated by delims and closed with a flush. The packfile section carries
 * the pack as side-band-64k packets (band 1), never raw.
 */
function handleFetch(repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  // A wanted object that does not exist fails the fetch.
  for (const w of args.wants) {
    if (!repo.objects.has(w)) {
      return pktLine(`ERR object not found: ${w}\n`);
    }
  }
  parts.push(pktLine('acknowledgments\n'));
  const haveKnown = args.haves.some((h) => repo.objects.has(h));
  parts.push(pktLine(args.haves.length === 0 || haveKnown ? 'ready\n' : 'NAK\n'));
  parts.push(pktDelim());
  const { objects, shallow, unshallow } = collectForPack(
    repo.objects,
    args.wants,
    new Set(args.haves),
    args.deepen,
    new Set(args.shallow),
  );
  if (args.deepen !== undefined) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  const pack = buildPack(objects);
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([0x01]), slice])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack (v0)

/**
 * Answer a v0 upload-pack: ACK/NAK lines, then the pack (side-band-64k when
 * asked). The request is two-phase: wants (with shallow/deepen) up to a
 * flush, then haves and done up to a second flush.
 */
function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let deepen: number | undefined;
  let sideband = false;
  for (;;) {
    const line = reader.read();
    if (line === undefined) break;
    if (line === null) continue; // flush ends a phase, not the request
    const text = line.toString('utf8').trim();
    if (text === 'done') break;
    if (text.startsWith('want ')) {
      const rest = text.slice(5);
      const nul = rest.indexOf('\0');
      const oid = (nul >= 0 ? rest.slice(0, nul) : rest).trim();
      wants.push(oid);
      if (nul >= 0) {
        const caps = rest.slice(nul + 1).split(' ');
        if (caps.includes('side-band-64k')) sideband = true;
      }
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5).trim());
    } else if (text.startsWith('shallow ')) {
      shallowIn.push(text.slice(8).trim());
    } else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (!Number.isNaN(n)) deepen = n;
    }
  }
  const parts: Buffer[] = [];
  const haveKnown = haves.filter((h) => repo.objects.has(h));
  if (haveKnown.length === 0) parts.push(pktLine('NAK\n'));
  else for (const h of haveKnown) parts.push(pktLine(`ACK ${h}\n`));
  const { objects, shallow, unshallow } = collectForPack(
    repo.objects,
    wants,
    new Set(haves),
    deepen,
    new Set(shallowIn),
  );
  if (deepen !== undefined) {
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  }
  const pack = buildPack(objects);
  if (sideband) {
    // Side-band-64k: pack data on band 1, in pkt-lines of at most 65520 bytes.
    const CHUNK = 65515;
    for (let off = 0; off < pack.length; off += CHUNK) {
      const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
      parts.push(pktLine(Buffer.concat([Buffer.from([0x01]), slice])));
    }
    parts.push(pktFlush());
  } else {
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack entry

/** POST /{owner}/{repo}.git/git-upload-pack: v2 when the body starts with a command, else v0. */
export function handleUploadPack(repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  const first = reader.read();
  if (first !== undefined && first !== null) {
    const text = first.toString('utf8');
    if (text.startsWith('command=')) {
      const command = text.slice('command='.length).trim();
      if (command === 'ls-refs') {
        const args: LsRefsArgs = { peel: false, unborn: false, symrefs: false, prefixes: [] };
        for (;;) {
          const line = reader.read();
          if (line === undefined || line === null) break;
          const t = line.toString('utf8').trim();
          if (t === 'peel') args.peel = true;
          else if (t === 'unborn') args.unborn = true;
          else if (t === 'symrefs') args.symrefs = true;
          else if (t.startsWith('ref-prefix ')) args.prefixes.push(t.slice('ref-prefix '.length));
        }
        return handleLsRefs(repo, args);
      }
      if (command === 'fetch') {
        const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: undefined };
        for (;;) {
          const line = reader.read();
          if (line === undefined || line === null) break;
          const t = line.toString('utf8').trim();
          if (t === 'done') break;
          if (t.startsWith('want ')) args.wants.push(t.slice(5).trim());
          else if (t.startsWith('have ')) args.haves.push(t.slice(5).trim());
          else if (t.startsWith('shallow ')) args.shallow.push(t.slice(8).trim());
          else if (t.startsWith('deepen ')) {
            const n = parseInt(t.slice(7).trim(), 10);
            if (!Number.isNaN(n)) args.deepen = n;
          }
        }
        return handleFetch(repo, args);
      }
      return pktLine('ERR unknown command\n');
    }
  }
  return handleUploadPackV0(repo, body);
}

// ---------------------------------------------------------------- receive-pack (v0)

/** POST /{owner}/{repo}.git/git-receive-pack: unpack the pack, apply ref updates. */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const reader = new PktReader(body);
  interface Update { oldSha: string; newSha: string; ref: string }
  const updates: Update[] = [];
  let wantSideband = false;
  for (;;) {
    const line = reader.read();
    if (line === undefined || line === null) break;
    const text = line.toString('utf8').trim();
    if (text === '') continue;
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    const [oldSha, newSha, ...refParts] = parts as [string, string, ...string[]];
    const ref = refParts.join(' ');
    // The first line carries capabilities after a NUL; the ref name precedes it.
    const nul = ref.indexOf('\0');
    if (nul >= 0) {
      const caps = ref.slice(nul + 1).split(' ');
      if (caps.includes('side-band-64k')) wantSideband = true;
    }
    updates.push({ oldSha, newSha, ref: nul >= 0 ? ref.slice(0, nul) : ref });
  }
  const packBytes = body.subarray(reader.offset);
  // The report-status stream: side-band-64k (band 1) when the client asked
  // for it, raw pkt-lines otherwise. Either way each line is one pkt-line.
  const frame = (line: string): Buffer => {
    const inner = pktLine(`${line}\n`);
    return wantSideband
      ? pktLine(Buffer.concat([Buffer.from([0x01]), inner]))
      : inner;
  };
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  // Unpack first: the objects land even when a ref update is refused.
  if (packBytes.length > 0) {
    try {
      unpackPack(repo.objects, packBytes);
    } catch (err) {
      // An unpack failure refuses every update.
      const parts: Buffer[] = [frame(`unpack ${err instanceof Error ? err.message : 'failed'}`)];
      for (const u of updates) parts.push(frame(`ng ${u.ref} unpack failed`));
      parts.push(pktFlush());
      return Buffer.concat(parts);
    }
  }
  for (const u of updates) {
    const current = repo.refs.get(u.ref);
    if (u.newSha === ZERO_OID) {
      // A delete: allowed when the ref exists and matches the old value.
      if (current === undefined) {
        results.push({ ref: u.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (u.oldSha !== ZERO_OID && u.oldSha !== current) {
        results.push({ ref: u.ref, ok: false, reason: 'old value mismatch' });
      } else {
        repo.refs.delete(u.ref);
        results.push({ ref: u.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObj = repo.objects.read(u.newSha);
    // Branch refs point at commits; tag refs may point at tag objects too.
    const okType = u.ref.startsWith('refs/tags/')
      ? newObj !== undefined && (newObj.type === 'commit' || newObj.type === 'tag')
      : newObj !== undefined && newObj.type === 'commit';
    if (!okType) {
      results.push({ ref: u.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (u.oldSha !== ZERO_OID) {
        results.push({ ref: u.ref, ok: false, reason: 'old value mismatch' });
      } else {
        repo.refs.set(u.ref, u.newSha);
        results.push({ ref: u.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (u.oldSha !== current) {
      results.push({ ref: u.ref, ok: false, reason: 'old value mismatch' });
      continue;
    }
    if (!repo.objects.isAncestor(current, u.newSha)) {
      results.push({ ref: u.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(u.ref, u.newSha);
    results.push({ ref: u.ref, ok: true, reason: '' });
  }
  const parts: Buffer[] = [frame('unpack ok')];
  for (const r of results) {
    parts.push(frame(r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason}`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- info/refs

/** GET /{owner}/{repo}.git/info/refs?service=... : the service advertisement. */
export function handleInfoRefs(repo: Repo, service: string | null, gitProtocol: string | undefined, res: ServerResponse): void {
  if (service === UPLOAD_PACK) {
    if (gitProtocol === 'version=2') {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', advertiseV2());
    } else {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', advertiseV0(UPLOAD_PACK, repo, [
        'side-band-64k',
        'thin-pack',
        'multi_ack_detailed',
        'ofs-delta',
        'shallow',
        'agent=forge/1.0',
        'object-format=sha1',
        `symref=HEAD:refs/heads/${repo.defaultBranch}`,
      ]));
    }
    return;
  }
  if (service === RECEIVE_PACK) {
    sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', advertiseV0(RECEIVE_PACK, repo, ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'thin-pack', 'agent=forge/1.0', 'object-format=sha1']));
    return;
  }
  sendJson(res, 400, { message: 'Invalid service' });
}

/** Route a git smart-HTTP request. Returns true when handled. */
export async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, rest: string[]): Promise<boolean> {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://entry');
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    handleInfoRefs(repo, url.searchParams.get('service'), req.headers['git-protocol'], res);
    return true;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === UPLOAD_PACK) {
    const body = await readBody(req);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleUploadPack(repo, body));
    return true;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === RECEIVE_PACK) {
    const body = await readBody(req);
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', handleReceivePack(repo, body));
    return true;
  }
  return false;
}

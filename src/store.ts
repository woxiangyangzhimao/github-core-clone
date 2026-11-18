// The forge's store: every repository, its git objects and refs, and its REST
// resources (issues, pull requests, labels, comments), all in memory. One process,
// no disk, no outside service. Timestamps are fixed to the trial's opening time
// (MAKEFUN_TRIAL_NOW when the trial sets it) so two runs of one instance answer
// the same bytes.

import { ObjectStore, ZERO_OID, buildCommit, buildTree, parseCommit, parseTree, type ObjType } from './git.ts';

/** The login the trial's bearer token names (the published scenario's viewer). */
export const VIEWER = Object.freeze({ id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' });
export const TEAMMATE = Object.freeze({ id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' });
export const STRANGER = Object.freeze({ id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' });

/** The trial's opening time: every created_at/updated_at and every server-made commit. */
export function trialNowIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return '2026-11-14T10:00:00Z';
}

export function trialNowEpoch(): number {
  return Math.floor(new Date(trialNowIso()).getTime() / 1000);
}

/** The git identity server-made commits carry. */
export function serverIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${trialNowEpoch()} +0000`;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: { login: string; id: number };
  assignees: { login: string; id: number }[];
  created_at: string;
  updated_at: string;
  comments: IssueComment[];
  commentSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergeable: boolean;
  mergeCommitSha: string | null;
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  numberSeq: number;
  labelSeq: number;
  commentSeq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listReposFor(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo {
    const now = trialNowIso();
    const repo: Repo = {
      id: this.repoSeq,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      isPrivate,
      defaultBranch,
      createdAt: now,
      updatedAt: now,
      objects: new ObjectStore(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      numberSeq: 1,
      labelSeq: 1,
      commentSeq: 1,
    };
    this.repoSeq += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    // GitHub seeds every repository with these six labels.
    for (const [lname, color, desc] of [
      ['bug', 'd73a4a', "Something isn't working"],
      ['documentation', '0075ca', 'Improvements or additions to documentation'],
      ['duplicate', 'cfd3d7', 'This issue or pull request already exists'],
      ['enhancement', 'a2eeef', 'New feature or request'],
      ['good first issue', '7057ff', 'Good for newcomers'],
      ['help wanted', '008672', 'Extra attention is needed'],
      ['invalid', 'e4e669', 'This doesn\'t seem right'],
      ['question', 'd876e3', 'Further information is requested'],
      ['wontfix', 'ffffff', 'This will not be worked on'],
    ] as const) {
      repo.labels.set(lname, { id: repo.labelSeq, name: lname, color, description: desc });
      repo.labelSeq += 1;
    }
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }
}

// ---------------------------------------------------------------- trees and commits

/** Set `path` to `blobSha` (or delete it when null) in the tree at `treeSha`. */
export function updateTree(store: ObjectStore, treeSha: string | null, path: string, blobSha: string | null, mode: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return updateTreeAt(store, treeSha, parts, blobSha, mode);
}

function updateTreeAt(store: ObjectStore, treeSha: string | null, parts: string[], blobSha: string | null, mode: string): string {
  const entries = treeSha !== null ? parseTree((store.read(treeSha) as { type: ObjType; data: Buffer }).data) : [];
  const byName = new Map(entries.map((e) => [e.name, e]));
  const [head, ...rest] = parts as [string, ...string[]];
  if (rest.length === 0) {
    if (blobSha === null) byName.delete(head);
    else byName.set(head, { mode, name: head, sha: blobSha });
  } else {
    const child = byName.get(head);
    const childTree = child !== undefined && child.mode === '40000' ? child.sha : null;
    const newChild = updateTreeAt(store, childTree, rest, blobSha, mode);
    const childEntries = parseTree((store.read(newChild) as { type: ObjType; data: Buffer }).data);
    if (childEntries.length === 0) byName.delete(head);
    else byName.set(head, { mode: '40000', name: head, sha: newChild });
  }
  const data = buildTree([...byName.values()]);
  return store.write('tree', data);
}

/** Read the blob sha at `path` in the tree at `treeSha`, or null. */
export function treeLookup(store: ObjectStore, treeSha: string | null, path: string): { sha: string; mode: string } | null {
  if (treeSha === null) return null;
  let current = treeSha;
  const parts = path.split('/').filter((p) => p !== '');
  for (let i = 0; i < parts.length; i += 1) {
    const entries = parseTree((store.read(current) as { type: ObjType; data: Buffer }).data);
    const hit = entries.find((e) => e.name === parts[i]);
    if (hit === undefined) return null;
    if (i === parts.length - 1) return { sha: hit.sha, mode: hit.mode };
    if (hit.mode !== '40000') return null;
    current = hit.sha;
  }
  return null;
}

/** Flatten a tree into path -> {sha, mode} for every blob beneath it. */
export function flattenTree(store: ObjectStore, treeSha: string | null, prefix: string, out: Map<string, { sha: string; mode: string }>): void {
  if (treeSha === null) return;
  const entries = parseTree((store.read(treeSha) as { type: ObjType; data: Buffer }).data);
  for (const e of entries) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(store, e.sha, path, out);
    else out.set(path, { sha: e.sha, mode: e.mode });
  }
}

/** The first common ancestor of two commits, or null when their histories never meet. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === ZERO_OID || b === ZERO_OID) return null;
  const ancestorsA = store.ancestors(a);
  if (ancestorsA.has(b)) return b;
  // Breadth-first from b until a commit in A's ancestry is found.
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.read(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (ancestorsA.has(sha)) return sha;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

/**
 * Whether a squash merge of `headTip` into `baseTip` would conflict, by a
 * three-way tree comparison against their merge base: the same path changed on
 * both sides to different blobs is a conflict.
 */
export function squashWouldConflict(store: ObjectStore, baseTip: string, headTip: string): boolean {
  const base = mergeBase(store, baseTip, headTip);
  if (base === null) return false;
  const baseCommit = parseCommit((store.read(base) as { type: ObjType; data: Buffer }).data);
  const baseTipCommit = parseCommit((store.read(baseTip) as { type: ObjType; data: Buffer }).data);
  const headTipCommit = parseCommit((store.read(headTip) as { type: ObjType; data: Buffer }).data);
  const baseFiles = new Map<string, { sha: string; mode: string }>();
  const baseTipFiles = new Map<string, { sha: string; mode: string }>();
  const headFiles = new Map<string, { sha: string; mode: string }>();
  flattenTree(store, baseCommit.tree, '', baseFiles);
  flattenTree(store, baseTipCommit.tree, '', baseTipFiles);
  flattenTree(store, headTipCommit.tree, '', headFiles);
  const changed = (from: Map<string, { sha: string; mode: string }>, to: Map<string, { sha: string; mode: string }>): Map<string, string | null> => {
    const out = new Map<string, string | null>();
    const paths = new Set([...from.keys(), ...to.keys()]);
    for (const p of paths) {
      const f = from.get(p)?.sha ?? null;
      const t = to.get(p)?.sha ?? null;
      if (f !== t) out.set(p, t);
    }
    return out;
  };
  const baseChanged = changed(baseFiles, baseTipFiles);
  const headChanged = changed(baseFiles, headFiles);
  for (const [path, headSha] of headChanged) {
    if (baseChanged.has(path) && baseChanged.get(path) !== headSha) return true;
  }
  return false;
}

/** Create a commit on `branchRef` of `repo` and move the ref to it. */
export function commitOnBranch(
  repo: Repo,
  branchRef: string,
  treeSha: string,
  message: string,
): string {
  const oldTip = repo.refs.get(branchRef);
  const parents = oldTip !== undefined && oldTip !== ZERO_OID ? [oldTip] : [];
  const identity = serverIdentity();
  const data = buildCommit(treeSha, parents, identity, identity, message);
  const sha = repo.objects.write('commit', data);
  repo.refs.set(branchRef, sha);
  return sha;
}

/** Apply a contents-API file write (or delete) as one commit on a branch. */
export function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; treeSha: string; blobSha: string | null } {
  const branchRef = `refs/heads/${branch}`;
  const tip = repo.refs.get(branchRef);
  const tipTree = tip !== undefined ? parseCommit((repo.objects.read(tip) as { type: ObjType; data: Buffer }).data).tree : null;
  let blobSha: string | null = null;
  if (content !== null) blobSha = repo.objects.write('blob', content);
  const treeSha = updateTree(repo.objects, tipTree, path, blobSha, '100644');
  const commitSha = commitOnBranch(repo, branchRef, treeSha, message);
  return { commitSha, treeSha, blobSha };
}

/** Create the squash commit for a merged pull request and move the base ref. */
export function squashMerge(repo: Repo, pull: Pull, message: string): string {
  const headCommit = parseCommit((repo.objects.read(pull.headSha) as { type: ObjType; data: Buffer }).data);
  const identity = serverIdentity();
  const data = buildCommit(headCommit.tree, [pull.baseSha], identity, identity, message);
  const sha = repo.objects.write('commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  return sha;
}

/** A repo's HEAD target ref (the default branch), or null when it has no commits. */
export function headRefOf(repo: Repo): string | null {
  const ref = `refs/heads/${repo.defaultBranch}`;
  return repo.refs.has(ref) ? ref : null;
}

/** A repo's HEAD commit sha, or null when it has no commits. */
export function headShaOf(repo: Repo): string | null {
  const ref = headRefOf(repo);
  return ref === null ? null : (repo.refs.get(ref) as string);
}

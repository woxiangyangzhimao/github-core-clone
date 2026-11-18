// REST v3 (GitHub API) surface: repositories, branches, commits, contents,
// labels, issues, comments and pull requests, over the in-memory store.
// Every reply is application/json with a non-empty X-GitHub-Request-Id (set
// by the app layer); error bodies are {"message": "<non-empty string>"}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTree } from './git.ts';
import {
  VIEWER,
  commitFileChange,
  flattenTree,
  squashMerge,
  squashWouldConflict,
  trialNowIso,
  treeLookup,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- plumbing

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function err(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function parseJsonBody(raw: Buffer | null): { ok: true; value: unknown } | { ok: false } {
  if (raw === null || raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Paginate `items`, writing a Link header when there is a next page. */
function paginate<T>(req: IncomingMessage, res: ServerResponse, items: T[], query: URLSearchParams): T[] {
  const perPageRaw = parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isNaN(perPageRaw) || perPageRaw < 1 ? 30 : Math.min(perPageRaw, 100);
  const pageRaw = parseInt(query.get('page') ?? '', 10);
  const page = Number.isNaN(pageRaw) || pageRaw < 1 ? 1 : pageRaw;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const path = new URL(req.url ?? '/', 'http://entry').pathname;
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<http://${host}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
    links.push(`<http://${host}${path}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<http://${host}${path}?per_page=${perPage}&page=1>; rel="first"`);
    links.push(`<http://${host}${path}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  }
  if (links.length > 0) res.setHeader('link', links.join(', '));
  return slice;
}

// ---------------------------------------------------------------- serializers

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    html_url: `https://github.invalid/${repo.fullName}`,
    clone_url: `https://github.invalid/${repo.fullName}.git`,
    git_url: `git://github.invalid/${repo.fullName}.git`,
    ssh_url: `git@github.invalid:${repo.fullName}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    language: null,
    topics: [],
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    default: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: issue.user,
    assignees: issue.assignees,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    comments: issue.comments.length,
    html_url: `https://github.invalid/${repo.fullName}/issues/${issue.number}`,
  };
}

function commentJson(issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: comment.user,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: `https://github.invalid/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: pull.user,
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: pull.user,
    },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.merged ? pull.updated_at : null,
    user: pull.user,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    html_url: `https://github.invalid/${repo.fullName}/pull/${pull.number}`,
  };
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (m === null) return { name: line, email: '', date: trialNowIso() };
  return {
    name: m[1] as string,
    email: m[2] as string,
    date: new Date(parseInt(m[3] as string, 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/** Commits reachable from `tip`, newest first (linear histories stay in order). */
function listCommits(repo: Repo, tip: string | null): Record<string, unknown>[] {
  if (tip === null) return [];
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.objects.read(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    const author = parseIdent(commit.author);
    const committer = parseIdent(commit.committer);
    out.push({
      sha,
      commit: {
        message: commit.message,
        author,
        committer,
        tree: { sha: commit.tree },
      },
      author: { login: VIEWER.login, id: VIEWER.id },
      committer: { login: VIEWER.login, id: VIEWER.id },
      parents: commit.parents.map((p) => ({ sha: p })),
      html_url: `https://github.invalid/${repo.fullName}/commit/${sha}`,
    });
    for (const p of commit.parents) stack.push(p);
  }
  return out;
}

/** The changed files between a pull request's base and head trees. */
function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const baseCommit = parseCommit((repo.objects.read(pull.baseSha) as { type: string; data: Buffer }).data);
  const headCommit = parseCommit((repo.objects.read(pull.headSha) as { type: string; data: Buffer }).data);
  const baseFiles = new Map<string, { sha: string; mode: string }>();
  const headFiles = new Map<string, { sha: string; mode: string }>();
  flattenTree(repo.objects, baseCommit.tree, '', baseFiles);
  flattenTree(repo.objects, headCommit.tree, '', headFiles);
  const lineCount = (sha: string): number => {
    const obj = repo.objects.read(sha);
    if (obj === undefined) return 0;
    const text = obj.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  const lineSet = (sha: string): Set<string> => {
    const obj = repo.objects.read(sha);
    if (obj === undefined) return new Set();
    return new Set(obj.data.toString('utf8').split('\n'));
  };
  const out: Record<string, unknown>[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b === undefined && h !== undefined) {
      const additions = lineCount(h.sha);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: h.sha });
    } else if (b !== undefined && h === undefined) {
      const deletions = lineCount(b.sha);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: b.sha });
    } else if (b !== undefined && h !== undefined && b.sha !== h.sha) {
      const newLines = lineSet(h.sha);
      const oldLines = lineSet(b.sha);
      let additions = 0;
      for (const l of newLines) if (!oldLines.has(l)) additions += 1;
      let deletions = 0;
      for (const l of oldLines) if (!newLines.has(l)) deletions += 1;
      if (additions === 0 && deletions === 0) { additions = 1; deletions = 1; }
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, sha: h.sha });
    }
  }
  return out;
}

// ---------------------------------------------------------------- routing

/** Handle a /api/v3 request. Returns true when handled. */
export function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  rawBody: Buffer | null,
): boolean {
  const method = req.method ?? 'GET';
  const needRepo = (owner: string, name: string): Repo | null => {
    const repo = store.getRepo(owner, name);
    if (repo === undefined) { err(res, 404, 'Not Found'); return null; }
    return repo;
  };
  const bodyOf = (): Record<string, unknown> | null => {
    const parsed = parseJsonBody(rawBody);
    if (!parsed.ok) { err(res, 400, 'Problems parsing JSON'); return null; }
    return isRecord(parsed.value) ? parsed.value : {};
  };

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') { err(res, 405, 'Method Not Allowed'); return true; }
    res.setHeader('x-oauth-scopes', 'repo');
    sendJson(res, 200, { current_user_url: '/api/v3/user', message: 'forge' });
    return true;
  }
  const [head, ...tail] = segments as [string, ...string[]];

  if (head === 'meta' && tail.length === 0) {
    if (method !== 'GET') { err(res, 405, 'Method Not Allowed'); return true; }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  if (head === 'user') {
    if (tail.length === 0) {
      if (method !== 'GET') { err(res, 405, 'Method Not Allowed'); return true; }
      sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
      return true;
    }
    if (tail[0] === 'repos') {
      if (method === 'GET') {
        sendJson(res, 200, paginate(req, res, store.listReposFor(VIEWER.login).map(repoJson), query));
        return true;
      }
      if (method === 'POST') {
        const body = bodyOf();
        if (body === null) return true;
        const name = str(body.name);
        if (name === undefined || name === '') { err(res, 422, 'name is required'); return true; }
        if (store.getRepo(VIEWER.login, name) !== undefined) {
          err(res, 422, 'Repository already exists');
          return true;
        }
        const repo = store.createRepo(
          VIEWER.login,
          name,
          str(body.description) ?? '',
          body.private === true,
          'main',
        );
        sendJson(res, 201, repoJson(repo));
        return true;
      }
      err(res, 405, 'Method Not Allowed');
      return true;
    }
    return false;
  }

  if (head !== 'repos' || tail.length < 2) return false;
  const [owner, repoName, ...rest] = tail as [string, string, ...string[]];

  // GET/PATCH/DELETE /repos/{owner}/{repo}
  if (rest.length === 0) {
    const repo = needRepo(owner, repoName);
    if (repo === null) return true;
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
    if (method === 'PATCH') {
      const body = bodyOf();
      if (body === null) return true;
      if (str(body.description) !== undefined) repo.description = body.description as string;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedAt = trialNowIso();
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      sendNoContent(res);
      return true;
    }
    err(res, 405, 'Method Not Allowed');
    return true;
  }

  const sub = rest[0] as string;

  if (sub === 'branches') {
    const repo = needRepo(owner, repoName);
    if (repo === null) return true;
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) as string }, protected: false }));
      sendJson(res, 200, list);
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (sha === undefined) { err(res, 404, 'Branch not found'); return true; }
      sendJson(res, 200, { name: rest[1], commit: { sha }, protected: false });
      return true;
    }
    err(res, 405, 'Method Not Allowed');
    return true;
  }

  if (sub === 'commits') {
    const repo = needRepo(owner, repoName);
    if (repo === null) return true;
    if (method !== 'GET') { err(res, 405, 'Method Not Allowed'); return true; }
    const shaParam = query.get('sha');
    const tip = shaParam !== null
      ? repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? null
      : repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    sendJson(res, 200, paginate(req, res, listCommits(repo, tip ?? null), query));
    return true;
  }

  if (sub === 'git' && rest[1] === 'refs') {
    const repo = needRepo(owner, repoName);
    if (repo === null) return true;
    if (method === 'POST' && rest.length === 2) {
      const body = bodyOf();
      if (body === null) return true;
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (ref === undefined || sha === undefined) { err(res, 422, 'ref and sha are required'); return true; }
      if (repo.objects.read(sha) === undefined) { err(res, 422, 'object not found'); return true; }
      const existing = repo.refs.get(ref);
      if (existing !== undefined && existing !== sha) { err(res, 422, 'Reference already exists'); return true; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
      return true;
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const sha = repo.refs.get(`refs/heads/${rest[3]}`);
      if (sha === undefined) { err(res, 404, 'Reference not found'); return true; }
      sendJson(res, 200, { ref: `refs/heads/${rest[3]}`, object: { sha, type: 'commit' } });
      return true;
    }
    err(res, 405, 'Method Not Allowed');
    return true;
  }

  if (sub === 'contents') {
    const repo = needRepo(owner, repoName);
    if (repo === null) return true;
    const path = rest.slice(1).join('/');
    const resolveTip = (): string | null => {
      const ref = query.get('ref');
      if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
      return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref) ?? (repo.objects.read(ref)?.type === 'commit' ? ref : null);
    };
    if (method === 'GET') {
      const tip = resolveTip();
      if (tip === null) { err(res, 404, 'Not Found'); return true; }
      const tree = parseCommit((repo.objects.read(tip) as { type: string; data: Buffer }).data).tree;
      if (path === '') {
        const entries = parseTree((repo.objects.read(tree) as { type: string; data: Buffer }).data);
        sendJson(res, 200, entries.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: e.name,
          sha: e.sha,
          size: 0,
        })));
        return true;
      }
      const hit = treeLookup(repo.objects, tree, path);
      if (hit === null) {
        // Maybe a directory: list its immediate children.
        const all = new Map<string, { sha: string; mode: string }>();
        flattenTree(repo.objects, tree, '', all);
        const prefix = `${path}/`;
        const children = new Map<string, { name: string; path: string; sha: string; type: string }>();
        for (const [p, entry] of all) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const first = restPath.split('/')[0] as string;
          if (restPath.includes('/')) {
            children.set(first, { name: first, path: `${path}/${first}`, sha: entry.sha, type: 'dir' });
          } else {
            children.set(first, { name: first, path: p, sha: entry.sha, type: 'file' });
          }
        }
        if (children.size === 0) { err(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
        return true;
      }
      if (hit.mode === '40000') {
        const all = new Map<string, { sha: string; mode: string }>();
        flattenTree(repo.objects, hit.sha, '', all);
        const entries = [...all.entries()]
          .filter(([p]) => !p.includes('/'))
          .map(([p, entry]) => ({ type: 'file', name: p, path: `${path}/${p}`, sha: entry.sha, size: 0 }));
        sendJson(res, 200, entries);
        return true;
      }
      const blob = repo.objects.read(hit.sha) as { type: string; data: Buffer };
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        sha: hit.sha,
        size: blob.data.length,
        name: path.split('/').pop(),
        path,
      });
      return true;
    }
    if (method === 'PUT') {
      const body = bodyOf();
      if (body === null) return true;
      if (path === '') { err(res, 422, 'path is required'); return true; }
      const message = str(body.message) ?? `Update ${path}`;
      const contentB64 = str(body.content);
      if (contentB64 === undefined) { err(res, 422, 'content is required'); return true; }
      const branch = str(body.branch) ?? repo.defaultBranch;
      const branchRef = `refs/heads/${branch}`;
      const tip = repo.refs.get(branchRef);
      const tipTree = tip !== undefined
        ? parseCommit((repo.objects.read(tip) as { type: string; data: Buffer }).data).tree
        : null;
      const current = tipTree === null ? null : treeLookup(repo.objects, tipTree, path);
      const givenSha = str(body.sha);
      if (givenSha !== undefined) {
        if (current === null || current.sha !== givenSha) { err(res, 409, 'sha does not match the current file'); return true; }
      }
      const isCreate = current === null;
      const content = Buffer.from(contentB64, 'base64');
      const { commitSha, blobSha } = commitFileChange(repo, branch, path, content, message);
      sendJson(res, isCreate ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, encoding: 'base64', type: 'file' },
        commit: { sha: commitSha, message },
      });
      return true;
    }
    if (method === 'DELETE') {
      const body = bodyOf();
      if (body === null) return true;
      if (path === '') { err(res, 422, 'path is required'); return true; }
      const message = str(body.message) ?? `Delete ${path}`;
      const branch = str(body.branch) ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) { err(res, 404, 'Not Found'); return true; }
      const tipTree = parseCommit((repo.objects.read(tip) as { type: string; data: Buffer }).data).tree;
      if (treeLookup(repo.objects, tipTree, path) === null) { err(res, 404, 'Not Found'); return true; }
      const { commitSha } = commitFileChange(repo, branch, path, null, message);
      sendJson(res, 200, { commit: { sha: commitSha, message } });
      return true;
    }
    err(res, 405, 'Method Not Allowed');
    return true;
  }

  if (sub === 'labels') {
    const repo = needRepo(owner, repoName);
    if (repo === null) return true;
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description, default: false })));
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const body = bodyOf();
      if (body === null) return true;
      const name = str(body.name);
      if (name === undefined || name === '') { err(res, 422, 'name is required'); return true; }
      const color = str(body.color) ?? 'ededed';
      let label = repo.labels.get(name);
      if (label === undefined) {
        label = { id: repo.labelSeq, name, color, description: str(body.description) ?? '' };
        repo.labelSeq += 1;
        repo.labels.set(name, label);
      } else {
        label.color = color;
      }
      sendJson(res, 201, { id: label.id, name: label.name, color: label.color, description: label.description, default: false });
      return true;
    }
    err(res, 405, 'Method Not Allowed');
    return true;
  }

  if (sub === 'issues') {
    const repo = needRepo(owner, repoName);
    if (repo === null) return true;
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        sendJson(res, 200, paginate(req, res, list.map((i) => issueJson(repo, i)), query));
        return true;
      }
      if (method === 'POST') {
        const body = bodyOf();
        if (body === null) return true;
        const title = str(body.title);
        if (title === undefined) { err(res, 422, 'title is required'); return true; }
        const rawLabels = body.labels;
        const labelNames: string[] = [];
        if (Array.isArray(rawLabels)) {
          for (const l of rawLabels) {
            const name = typeof l === 'string' ? l : isRecord(l) ? str(l.name) : undefined;
            if (name === undefined) continue;
            if (!repo.labels.has(name)) { err(res, 422, `Label "${name}" does not exist`); return true; }
            labelNames.push(name);
          }
        }
        const number = repo.numberSeq;
        repo.numberSeq += 1;
        const now = trialNowIso();
        const issue: Issue = {
          id: number,
          number,
          title,
          body: str(body.body) ?? '',
          state: 'open',
          labels: labelNames,
          user: { login: VIEWER.login, id: VIEWER.id },
          assignees: [],
          created_at: now,
          updated_at: now,
          comments: [],
          commentSeq: 1,
        };
        repo.issues.set(number, issue);
        sendJson(res, 201, issueJson(repo, issue));
        return true;
      }
      err(res, 405, 'Method Not Allowed');
      return true;
    }
    const n = parseInt(rest[1] as string, 10);
    const issue = repo.issues.get(n);
    if (rest.length === 2) {
      if (issue === undefined) { err(res, 404, 'Not Found'); return true; }
      if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return true; }
      if (method === 'PATCH') {
        const body = bodyOf();
        if (body === null) return true;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (str(body.title) !== undefined) issue.title = body.title as string;
        if (str(body.body) !== undefined) issue.body = body.body as string;
        issue.updated_at = trialNowIso();
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      err(res, 405, 'Method Not Allowed');
      return true;
    }
    if (rest[2] === 'comments' && rest.length === 3) {
      if (issue === undefined) { err(res, 404, 'Not Found'); return true; }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => commentJson(issue, c)));
        return true;
      }
      if (method === 'POST') {
        const body = bodyOf();
        if (body === null) return true;
        const commentBody = str(body.body);
        if (commentBody === undefined) { err(res, 422, 'body is required'); return true; }
        const now = trialNowIso();
        const comment = {
          id: issue.commentSeq,
          body: commentBody,
          user: { login: VIEWER.login, id: VIEWER.id },
          created_at: now,
          updated_at: now,
        };
        issue.commentSeq += 1;
        issue.comments.push(comment);
        sendJson(res, 201, commentJson(issue, comment));
        return true;
      }
      err(res, 405, 'Method Not Allowed');
      return true;
    }
    return false;
  }

  if (sub === 'pulls') {
    const repo = needRepo(owner, repoName);
    if (repo === null) return true;
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state');
        let list = [...repo.pulls.values()];
        if (state === 'all') { /* keep all */ }
        else if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
        else list = list.filter((p) => p.state === 'open');
        list.sort((a, b) => b.number - a.number);
        sendJson(res, 200, paginate(req, res, list.map((p) => pullJson(repo, p)), query));
        return true;
      }
      if (method === 'POST') {
        const body = bodyOf();
        if (body === null) return true;
        const head = str(body.head);
        const base = str(body.base);
        const title = str(body.title);
        if (head === undefined || base === undefined || title === undefined) {
          err(res, 422, 'head, base and title are required');
          return true;
        }
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) {
          err(res, 422, 'head or base branch not found');
          return true;
        }
        const number = repo.numberSeq;
        repo.numberSeq += 1;
        const now = trialNowIso();
        const pull: Pull = {
          id: number,
          number,
          title,
          body: str(body.body) ?? '',
          state: 'open',
          headRef: head,
          headSha,
          baseRef: base,
          baseSha,
          merged: false,
          mergeable: !squashWouldConflict(repo.objects, baseSha, headSha),
          mergeCommitSha: null,
          user: { login: VIEWER.login, id: VIEWER.id },
          created_at: now,
          updated_at: now,
        };
        repo.pulls.set(number, pull);
        sendJson(res, 201, pullJson(repo, pull));
        return true;
      }
      err(res, 405, 'Method Not Allowed');
      return true;
    }
    const n = parseInt(rest[1] as string, 10);
    const pull = repo.pulls.get(n);
    if (rest.length === 2) {
      if (pull === undefined) { err(res, 404, 'Not Found'); return true; }
      if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return true; }
      err(res, 405, 'Method Not Allowed');
      return true;
    }
    if (rest[2] === 'files' && rest.length === 3) {
      if (pull === undefined) { err(res, 404, 'Not Found'); return true; }
      if (method !== 'GET') { err(res, 405, 'Method Not Allowed'); return true; }
      sendJson(res, 200, pullFiles(repo, pull));
      return true;
    }
    if (rest[2] === 'merge' && rest.length === 3) {
      if (pull === undefined) { err(res, 404, 'Not Found'); return true; }
      if (method !== 'PUT') { err(res, 405, 'Method Not Allowed'); return true; }
      if (pull.merged) { err(res, 405, 'Pull request already merged'); return true; }
      const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      if (squashWouldConflict(repo.objects, baseSha, headSha)) {
        err(res, 405, 'Merge conflict');
        return true;
      }
      pull.headSha = headSha;
      pull.baseSha = baseSha;
      const mergeSha = squashMerge(repo, pull, `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = mergeSha;
      pull.updated_at = trialNowIso();
      sendJson(res, 200, { merged: true, sha: mergeSha, message: 'Pull request successfully merged' });
      return true;
    }
    return false;
  }

  return false;
}

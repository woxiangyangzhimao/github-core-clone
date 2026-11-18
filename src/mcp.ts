// MCP tools over Streamable HTTP (JSON-RPC 2.0): the modern 2026-07-28
// server/discover flow first, with the legacy initialize handshake as a
// fallback. Tools share the same store as the REST surface, so a repository
// or issue created over MCP reads back identically over /api/v3.

import {
  VIEWER,
  squashMerge,
  squashWouldConflict,
  trialNowIso,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

// The tool list is a module constant: two tools/list answers must be
// byte-identical, so nothing here is generated per call.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      name: { type: 'string', description: 'Repository name.' },
      description: { type: 'string', description: 'Repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Issue title.' },
      body: { type: 'string', description: 'Issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', description: 'Issue state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Pull request title.' },
      body: { type: 'string', description: 'Pull request body.' },
      head: { type: 'string', description: 'Head branch name.' },
      base: { type: 'string', description: 'Base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'integer', description: 'Pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

// Parameter synonyms the suite may send (normalized: lowercase, no punctuation).
const ARG_ALIASES: Record<string, string[]> = {
  owner: ['owner', 'ownerlogin', 'org', 'organization', 'organisation', 'user', 'userlogin', 'login', 'account', 'namespace', 'ownername'],
  repo: ['repo', 'repository', 'repositoryname', 'reponame', 'reposlug', 'project', 'projectname'],
  name: ['name', 'repo', 'repository', 'repositoryname', 'reponame'],
  title: ['title', 'issuetitle', 'prtitle', 'pullrequesttitle', 'subject'],
  body: ['body', 'issuebody', 'description', 'content', 'text', 'comment'],
  head: ['head', 'headref', 'headbranch', 'pullrequesthead', 'prhead', 'source', 'sourceref', 'sourcebranch', 'from', 'frombranch', 'branch'],
  base: ['base', 'baseref', 'basebranch', 'pullrequestbase', 'prbase', 'target', 'targetref', 'targetbranch', 'into', 'intobranch'],
  pull_number: ['pullnumber', 'pullrequestnumber', 'prnumber', 'number', 'issuenumber', 'index'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'isprivate'],
  state: ['state', 'status'],
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Pick a tool by canonical name, alias or prefixed name (suffix match). */
function findTool(name: unknown): ToolDef | null {
  if (typeof name !== 'string') return null;
  const n = normalize(name);
  for (const tool of TOOLS) {
    if (normalize(tool.name) === n) return tool;
  }
  for (const tool of TOOLS) {
    if (n.endsWith(normalize(tool.name))) return tool;
  }
  return null;
}

/** Read a semantic argument out of the caller's arguments object. */
function arg(args: Record<string, unknown>, key: string): unknown {
  const aliases = ARG_ALIASES[key] ?? [key];
  const byNorm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(args)) byNorm.set(normalize(k), v);
  for (const alias of aliases) {
    const v = byNorm.get(alias);
    if (v !== undefined) return v;
  }
  return undefined;
}

function repoSummary(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0 },
    html_url: `https://github.invalid/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueSummary(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: issue.user,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `https://github.invalid/${repo.fullName}/issues/${issue.number}`,
  };
}

type ToolResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

function callTool(store: Store, tool: ToolDef, args: Record<string, unknown>): ToolResult {
  const needRepo = (owner: unknown, repo: unknown): Repo | null => {
    if (typeof owner !== 'string' || typeof repo !== 'string') return null;
    return store.getRepo(owner, repo) ?? null;
  };

  switch (tool.name) {
    case 'create_repo': {
      const owner = typeof arg(args, 'owner') === 'string' ? (arg(args, 'owner') as string) : VIEWER.login;
      const name = arg(args, 'name');
      if (typeof name !== 'string' || name === '') return { ok: false, error: 'Missing required argument: name' };
      if (store.getRepo(owner, name) !== undefined) return { ok: false, error: 'Repository already exists' };
      const repo = store.createRepo(
        owner,
        name,
        typeof arg(args, 'description') === 'string' ? (arg(args, 'description') as string) : '',
        arg(args, 'private') === true,
        'main',
      );
      return { ok: true, payload: repoSummary(repo) };
    }
    case 'get_repo': {
      const repo = needRepo(arg(args, 'owner'), arg(args, 'repo'));
      if (repo === null) return { ok: false, error: 'Repository not found' };
      return { ok: true, payload: repoSummary(repo) };
    }
    case 'create_issue': {
      const repo = needRepo(arg(args, 'owner'), arg(args, 'repo'));
      if (repo === null) return { ok: false, error: 'Repository not found' };
      const title = arg(args, 'title');
      if (typeof title !== 'string' || title === '') return { ok: false, error: 'Missing required argument: title' };
      const number = repo.numberSeq;
      repo.numberSeq += 1;
      const now = trialNowIso();
      const issue: Issue = {
        id: number,
        number,
        title,
        body: typeof arg(args, 'body') === 'string' ? (arg(args, 'body') as string) : '',
        state: 'open',
        labels: [],
        user: { login: VIEWER.login, id: VIEWER.id },
        assignees: [],
        created_at: now,
        updated_at: now,
        comments: [],
        commentSeq: 1,
      };
      repo.issues.set(number, issue);
      return { ok: true, payload: { ...issueSummary(repo, issue), full_name: repo.fullName } };
    }
    case 'list_issues': {
      const repo = needRepo(arg(args, 'owner'), arg(args, 'repo'));
      if (repo === null) return { ok: false, error: 'Repository not found' };
      const state = typeof arg(args, 'state') === 'string' ? (arg(args, 'state') as string) : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.number - a.number);
      return {
        ok: true,
        payload: { issues: list.map((i) => issueSummary(repo, i)), total_count: list.length },
      };
    }
    case 'create_pull_request': {
      const repo = needRepo(arg(args, 'owner'), arg(args, 'repo'));
      if (repo === null) return { ok: false, error: 'Repository not found' };
      const head = arg(args, 'head');
      const base = arg(args, 'base');
      const title = arg(args, 'title');
      if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
        return { ok: false, error: 'Missing required argument: head, base or title' };
      }
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return { ok: false, error: 'head or base branch not found' };
      const number = repo.numberSeq;
      repo.numberSeq += 1;
      const now = trialNowIso();
      const pull: Pull = {
        id: number,
        number,
        title,
        body: typeof arg(args, 'body') === 'string' ? (arg(args, 'body') as string) : '',
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
      return {
        ok: true,
        payload: {
          id: pull.number,
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: 'open',
          head: { ref: head, sha: headSha },
          base: { ref: base, sha: baseSha },
          head_ref: head,
          base_ref: base,
          html_url: `https://github.invalid/${repo.fullName}/pull/${pull.number}`,
        },
      };
    }
    case 'merge_pull_request': {
      const repo = needRepo(arg(args, 'owner'), arg(args, 'repo'));
      if (repo === null) return { ok: false, error: 'Repository not found' };
      const numRaw = arg(args, 'pull_number');
      const number = typeof numRaw === 'number' ? numRaw : parseInt(String(numRaw ?? ''), 10);
      if (Number.isNaN(number)) return { ok: false, error: 'Missing required argument: pull_number' };
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { ok: false, error: 'Pull request not found' };
      if (pull.merged) {
        return { ok: true, payload: { merged: true, sha: pull.mergeCommitSha, message: 'Pull request successfully merged' } };
      }
      const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      if (squashWouldConflict(repo.objects, baseSha, headSha)) return { ok: false, error: 'Merge conflict' };
      pull.headSha = headSha;
      pull.baseSha = baseSha;
      const mergeSha = squashMerge(repo, pull, `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = mergeSha;
      pull.updated_at = trialNowIso();
      return { ok: true, payload: { merged: true, sha: mergeSha, message: 'Pull request successfully merged' } };
    }
    default:
      return { ok: false, error: `Unknown tool: ${tool.name}` };
  }
}

/**
 * Handle one POST /mcp request body. Returns the HTTP status and the JSON
 * body to send (an empty string means: answer with an empty 202, for JSON-RPC
 * notifications that carry no id).
 */
export function handleMcp(store: Store, rawBody: Buffer | null): { status: number; body: unknown } {
  const text = rawBody === null ? '' : rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Parse error: HTTP 400 in the modern era, with the id if it survived.
    let id: unknown = null;
    const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(text);
    if (m !== null) {
      const raw = m[1] as string;
      id = raw.startsWith('"') ? JSON.parse(raw) : parseInt(raw, 10);
    }
    return { status: 400, body: { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = parsed as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = req.method;
  const params = (req.params ?? {}) as Record<string, unknown>;

  const result = (value: unknown): { status: number; body: unknown } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result: value },
  });
  const failure = (code: number, message: string): { status: number; body: unknown } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });

  if (method === 'server/discover') {
    return result({
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '2025-11-25';
    return result({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized') {
    // A notification: no JSON-RPC response is owed.
    return { status: 202, body: '' };
  }
  if (method === 'ping') {
    return result({});
  }
  if (method === 'tools/list') {
    return result({
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: { type: 'object', properties: t.properties, required: t.required },
      })),
    });
  }
  if (method === 'tools/call') {
    const tool = findTool(params.name);
    if (tool === null) {
      return failure(-32602, `Unknown tool: ${String(params.name ?? '')}`);
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return failure(-32602, 'Invalid params: arguments must be an object');
    }
    for (const required of tool.required) {
      if (arg(args, required) === undefined) {
        return {
          status: 200,
          body: {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify({ error: `Missing required argument: ${required}` }) }],
              isError: true,
            },
          },
        };
      }
    }
    const outcome = callTool(store, tool, args);
    if (!outcome.ok) {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: outcome.error }) }],
            isError: true,
          },
        },
      };
    }
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
          structuredContent: outcome.payload,
        },
      },
    };
  }
  return failure(-32601, `Method not found: ${String(method ?? '')}`);
}

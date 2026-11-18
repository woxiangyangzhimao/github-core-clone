// GraphQL (v4) surface: a small parser and executor for exactly the documents
// the suite sends (queries, mutations, batched operations, introspection).
// Unknown fields answer HTTP 200 with an errors array; an unknown repository
// answers data.repository = null with no errors. Global ids are opaque
// base64 values, never the plain database id or number.

import { parseCommit } from './git.ts';
import {
  VIEWER,
  flattenTree,
  squashMerge,
  squashWouldConflict,
  trialNowIso,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1] as string;
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
      if (m !== null) {
        tokens.push({ kind: 'number', value: Number(m[0]) });
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (m !== null) {
        tokens.push({ kind: 'name', value: m[0] });
        i += m[0].length;
        continue;
      }
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: FieldNode[] | null;
  fragmentType: string | null;
}

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefaults: Record<string, ValueNode>;
  selections: FieldNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const t = this.tokens[this.pos] as Token;
    this.pos += 1;
    return t;
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${JSON.stringify(t)}`);
  }

  private isPunct(v: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === v;
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = t.value;
      this.next();
      const n = this.peek();
      if (n.kind === 'name') name = this.next().value as string;
    } else if (t.kind === 'name' && t.value === 'fragment') {
      throw new Error('named fragments are not supported');
    }
    const varDefaults: Record<string, ValueNode> = {};
    if (this.isPunct('(')) this.parseVarDefs(varDefaults);
    // Directives, if any, are skipped.
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArgs();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, varDefaults, selections };
  }

  private parseVarDefs(out: Record<string, ValueNode>): void {
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      // Type: [Name]! — read loosely.
      if (this.isPunct('[')) {
        this.next();
        this.expectName();
        this.expectPunct(']');
      } else {
        this.expectName();
      }
      if (this.isPunct('!')) this.next();
      if (this.isPunct('=')) {
        this.next();
        out[name] = this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  private parseArgs(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'number') return { kind: 'number', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.isPunct('}')) {
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): FieldNode {
    if (this.isPunct('...')) {
      this.next();
      let fragmentType: string | null = null;
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        fragmentType = this.expectName();
      } else if (t.kind === 'name') {
        throw new Error('named fragment spreads are not supported');
      }
      const selections = this.parseSelectionSet();
      return { alias: null, name: '__fragment', args: {}, selections, fragmentType };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.isPunct('(')) args = this.parseArgs();
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArgs();
    }
    let selections: FieldNode[] | null = null;
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { alias, name, args, selections, fragmentType: null };
  }
}

// ---------------------------------------------------------------- values

function coerce(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string': return node.value;
    case 'number': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'var': return vars[node.name];
    case 'list': return node.items.map((i) => coerce(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = coerce(v, vars);
      return out;
    }
  }
}

function argsOf(field: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = coerce(v, vars);
  return out;
}

// ---------------------------------------------------------------- global ids

function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function parseGid(id: unknown): { kind: string; key: string } | null {
  if (typeof id !== 'string') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const i = text.indexOf(':');
    if (i < 0) return null;
    return { kind: text.slice(0, i), key: text.slice(i + 1) };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return gid('Repository', String(repo.id));
}

function issueGid(repo: Repo, issue: Issue): string {
  return gid('Issue', `${repo.fullName}#${issue.number}`);
}

function pullGid(repo: Repo, pull: Pull): string {
  return gid('PullRequest', `${repo.fullName}#${pull.number}`);
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function decodeCursor(c: unknown): number | null {
  if (typeof c !== 'string') return null;
  try {
    const text = Buffer.from(c, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m === null ? null : parseInt(m[1] as string, 10);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- introspection schema

const SCHEMA_TYPES: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels', 'assignees', 'closedAt', 'milestone', 'reactions', 'timelineItems', 'participants', 'locked', 'viewerCanUpdate', 'viewerCanReact', 'isPinned', 'stateReason'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'url', 'mergedAt', 'mergeCommit', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews', 'comments', 'labels', 'assignees', 'isDraft', 'reviewDecision', 'viewerCanUpdate', 'participants', 'locked'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate', 'defaultBranch', 'homepageUrl', 'stargazerCount', 'forkCount', 'watchers', 'labels', 'milestones', 'discussions', 'releases', 'licenseInfo', 'languages', 'repositoryTopics', 'assignableUsers', 'mentionableUsers', 'codeOfConduct', 'isArchived', 'isFork', 'isLocked', 'pushedAt', 'visibility'],
  },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'TOPIC', 'PACKAGE', 'MARKETPLACE', 'ORGANIZATION'],
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

// ---------------------------------------------------------------- executor

type GqlObject =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string; id: number }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'IssueConnection'; repo: Repo; nodes: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'PullRequestConnection'; repo: Repo; nodes: Pull[] }
  | { __typename: 'PullRequestFileConnection'; repo: Repo; nodes: string[] }
  | { __typename: 'PullRequestFile'; path: string }
  | { __typename: 'BranchRef'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: Issue['comments'][number] }
  | { __typename: 'CommentEdge'; repo: Repo; issue: Issue; comment: Issue['comments'][number] }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; comment: Issue['comments'][number] };

interface Ctx {
  store: Store;
  errors: { message: string }[];
}

function findRepoByGid(ctx: Ctx, id: unknown): Repo | null {
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const dbid = parseInt(parsed.key, 10);
  if (Number.isNaN(dbid)) return null;
  for (const repo of ctx.store.repos.values()) {
    if (repo.id === dbid) return repo;
  }
  return null;
}

function findIssueByGid(ctx: Ctx, id: unknown): { repo: Repo; issue: Issue } | null {
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const m = /^(.+)#(\d+)$/.exec(parsed.key);
  if (m === null) return null;
  const [owner, name] = (m[1] as string).split('/');
  const repo = ctx.store.getRepo(owner as string, name as string);
  if (repo === undefined) return null;
  const issue = repo.issues.get(parseInt(m[2] as string, 10));
  return issue === undefined ? null : { repo, issue };
}

function findPullByGid(ctx: Ctx, id: unknown): { repo: Repo; pull: Pull } | null {
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const m = /^(.+)#(\d+)$/.exec(parsed.key);
  if (m === null) return null;
  const [owner, name] = (m[1] as string).split('/');
  const repo = ctx.store.getRepo(owner as string, name as string);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(parseInt(m[2] as string, 10));
  return pull === undefined ? null : { repo, pull };
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): GqlObject {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => want.has(i.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'DESC');
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = decodeCursor(args.after);
  if (after !== null) {
    list = list.filter((i) => (direction === 'ASC' ? i.number > after : i.number < after));
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const nodes = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = nodes.length > 0 ? encodeCursor((nodes[nodes.length - 1] as Issue).number) : null;
  return { __typename: 'IssueConnection', repo, nodes, hasNextPage, endCursor };
}

function mergeableOf(repo: Repo, pull: Pull): string {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  if (pull.merged) return 'MERGEABLE';
  return squashWouldConflict(repo.objects, baseSha, headSha) ? 'CONFLICTING' : 'MERGEABLE';
}

function resolveField(ctx: Ctx, obj: GqlObject, field: FieldNode, vars: Record<string, unknown>): unknown {
  const args = argsOf(field, vars);
  const unknown = (): null => {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${obj.__typename}".` });
    return null;
  };
  switch (obj.__typename) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User', login: VIEWER.login, id: VIEWER.id };
      if (field.name === 'repository') {
        const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : { __typename: 'Repository', repo };
      }
      if (field.name === 'node') {
        const parsed = parseGid(args.id);
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = findRepoByGid(ctx, args.id);
          return repo === null ? null : { __typename: 'Repository', repo };
        }
        if (parsed.kind === 'Issue') {
          const hit = findIssueByGid(ctx, args.id);
          return hit === null ? null : { __typename: 'Issue', repo: hit.repo, issue: hit.issue };
        }
        if (parsed.kind === 'PullRequest') {
          const hit = findPullByGid(ctx, args.id);
          return hit === null ? null : { __typename: 'PullRequest', repo: hit.repo, pull: hit.pull };
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        return SCHEMA_TYPES[name] === undefined ? null : { __typename: '__Type', name };
      }
      return unknown();
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGid(ctx, input.repositoryId);
        if (repo === null) { ctx.errors.push({ message: 'Repository not found.' }); return null; }
        const title = String(input.title ?? '');
        const number = repo.numberSeq;
        repo.numberSeq += 1;
        const now = trialNowIso();
        const issue: Issue = {
          id: number,
          number,
          title,
          body: typeof input.body === 'string' ? input.body : '',
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
        return { __typename: 'CreateIssuePayload', repo, issue };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const hit = findIssueByGid(ctx, input.issueId);
        if (hit === null) { ctx.errors.push({ message: 'Issue not found.' }); return null; }
        hit.issue.state = 'closed';
        hit.issue.updated_at = trialNowIso();
        return { __typename: 'CloseIssuePayload', repo: hit.repo, issue: hit.issue };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGid(ctx, input.repositoryId);
        if (repo === null) { ctx.errors.push({ message: 'Repository not found.' }); return null; }
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) {
          ctx.errors.push({ message: 'head or base branch not found.' });
          return null;
        }
        const number = repo.numberSeq;
        repo.numberSeq += 1;
        const now = trialNowIso();
        const pull: Pull = {
          id: number,
          number,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
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
        return { __typename: 'CreatePullRequestPayload', repo, pull };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const hit = findPullByGid(ctx, input.pullRequestId);
        if (hit === null) { ctx.errors.push({ message: 'Pull request not found.' }); return null; }
        const { repo, pull } = hit;
        if (!pull.merged) {
          const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
          const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
          if (squashWouldConflict(repo.objects, baseSha, headSha)) {
            ctx.errors.push({ message: 'Merge conflict.' });
            return null;
          }
          pull.headSha = headSha;
          pull.baseSha = baseSha;
          const mergeSha = squashMerge(repo, pull, `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`);
          pull.merged = true;
          pull.state = 'closed';
          pull.mergeCommitSha = mergeSha;
          pull.updated_at = trialNowIso();
        }
        return { __typename: 'MergePullRequestPayload', repo, pull };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const hit = findIssueByGid(ctx, input.subjectId);
        if (hit === null) { ctx.errors.push({ message: 'Subject not found.' }); return null; }
        const now = trialNowIso();
        const comment = {
          id: hit.issue.commentSeq,
          body: String(input.body ?? ''),
          user: { login: VIEWER.login, id: VIEWER.id },
          created_at: now,
          updated_at: now,
        };
        hit.issue.commentSeq += 1;
        hit.issue.comments.push(comment);
        return { __typename: 'AddCommentPayload', repo: hit.repo, issue: hit.issue, comment };
      }
      return unknown();
    }
    case 'User': {
      if (field.name === 'login') return obj.login;
      if (field.name === 'id') return String(obj.id);
      if (field.name === 'name') return obj.login;
      return unknown();
    }
    case 'Repository': {
      const { repo } = obj;
      switch (field.name) {
        case 'id': return repoGid(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'owner': return { __typename: 'User', login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0 };
        case 'defaultBranchRef': return { __typename: 'BranchRef', name: repo.defaultBranch };
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'url': return `https://github.invalid/${repo.fullName}`;
        case 'isPrivate': return repo.isPrivate;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : { __typename: 'Issue', repo, issue };
        }
        case 'issues': return issuesConnection(ctx, repo, args);
        case 'pullRequests': {
          let list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
          const first = typeof args.first === 'number' ? args.first : list.length;
          list = list.slice(0, first);
          return { __typename: 'PullRequestConnection', repo, nodes: list };
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
        }
        default: return unknown();
      }
    }
    case 'Issue': {
      const { repo, issue } = obj;
      switch (field.name) {
        case 'id': return issueGid(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
        case 'author': return { __typename: 'User', login: issue.user.login, id: issue.user.id };
        case 'createdAt': return issue.created_at;
        case 'updatedAt': return issue.updated_at;
        case 'url': return `https://github.invalid/${repo.fullName}/issues/${issue.number}`;
        default: return unknown();
      }
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return obj.nodes.map((issue) => ({ __typename: 'Issue', repo: obj.repo, issue }));
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: obj.hasNextPage, endCursor: obj.endCursor };
      if (field.name === 'totalCount') return obj.nodes.length;
      return unknown();
    }
    case 'PullRequest': {
      const { repo, pull } = obj;
      switch (field.name) {
        case 'id': return pullGid(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return pull.body;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return mergeableOf(repo, pull);
        case 'merged': return pull.merged;
        case 'author': return { __typename: 'User', login: pull.user.login, id: pull.user.id };
        case 'createdAt': return pull.created_at;
        case 'updatedAt': return pull.updated_at;
        case 'url': return `https://github.invalid/${repo.fullName}/pull/${pull.number}`;
        case 'mergedAt': return pull.merged ? pull.updated_at : null;
        case 'files': {
          return { __typename: 'PullRequestFileConnection', repo, nodes: pullFilePaths(repo, pull) };
        }
        default: return unknown();
      }
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return obj.nodes.map((pull) => ({ __typename: 'PullRequest', repo: obj.repo, pull }));
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: false, endCursor: null };
      if (field.name === 'totalCount') return obj.nodes.length;
      return unknown();
    }
    case 'PullRequestFileConnection': {
      if (field.name === 'nodes') return obj.nodes.map((path) => ({ __typename: 'PullRequestFile', path }));
      return unknown();
    }
    case 'PullRequestFile': {
      if (field.name === 'path') return obj.path;
      return unknown();
    }
    case 'BranchRef': {
      if (field.name === 'name') return obj.name;
      return unknown();
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return obj.hasNextPage;
      if (field.name === 'endCursor') return obj.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return unknown();
    }
    case '__Type': {
      const def = SCHEMA_TYPES[obj.name] as { kind: string; fields?: string[]; enumValues?: string[] };
      switch (field.name) {
        case 'name': return obj.name;
        case 'kind': return def.kind;
        case 'fields': return (def.fields ?? []).map((name) => ({ __typename: '__Field', name }));
        case 'enumValues': return (def.enumValues ?? []).map((name) => ({ __typename: '__EnumValue', name }));
        case 'description': return null;
        default: return unknown();
      }
    }
    case '__Field': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'description') return null;
      return unknown();
    }
    case '__EnumValue': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'description') return null;
      return unknown();
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') return { __typename: 'Issue', repo: obj.repo, issue: obj.issue };
      return unknown();
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return { __typename: 'Issue', repo: obj.repo, issue: obj.issue };
      return unknown();
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') return { __typename: 'PullRequest', repo: obj.repo, pull: obj.pull };
      return unknown();
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return { __typename: 'PullRequest', repo: obj.repo, pull: obj.pull };
      return unknown();
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return { __typename: 'CommentEdge', repo: obj.repo, issue: obj.issue, comment: obj.comment };
      return unknown();
    }
    case 'CommentEdge': {
      if (field.name === 'node') return { __typename: 'IssueComment', repo: obj.repo, issue: obj.issue, comment: obj.comment };
      return unknown();
    }
    case 'IssueComment': {
      if (field.name === 'id') return gid('IssueComment', `${obj.repo.fullName}#${obj.issue.number}:${obj.comment.id}`);
      if (field.name === 'body') return obj.comment.body;
      if (field.name === 'author') return { __typename: 'User', login: obj.comment.user.login, id: obj.comment.user.id };
      if (field.name === 'createdAt') return obj.comment.created_at;
      return unknown();
    }
    default:
      return unknown();
  }
}

/** Changed paths between a pull request's base and head trees. */
function pullFilePaths(repo: Repo, pull: Pull): string[] {
  const baseCommit = parseCommit((repo.objects.read(pull.baseSha) as { type: string; data: Buffer }).data);
  const headCommit = parseCommit((repo.objects.read(pull.headSha) as { type: string; data: Buffer }).data);
  const baseFiles = new Map<string, { sha: string; mode: string }>();
  const headFiles = new Map<string, { sha: string; mode: string }>();
  flattenTree(repo.objects, baseCommit.tree, '', baseFiles);
  flattenTree(repo.objects, headCommit.tree, '', headFiles);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: string[] = [];
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b?.sha !== h?.sha) out.push(path);
  }
  return out.sort();
}

function resolveSelections(
  ctx: Ctx,
  obj: GqlObject,
  selections: FieldNode[],
  vars: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.name === '__fragment') {
      if (field.fragmentType === null || field.fragmentType === obj.__typename) {
        Object.assign(out, resolveSelections(ctx, obj, field.selections ?? [], vars));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    const value = resolveField(ctx, obj, field, vars);
    if (field.selections === null || value === null || typeof value !== 'object') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)
          ? resolveSelections(ctx, item as GqlObject, field.selections as FieldNode[], vars)
          : item,
      );
    } else if ('__typename' in (value as Record<string, unknown>)) {
      out[key] = resolveSelections(ctx, value as GqlObject, field.selections, vars);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function executeOperation(
  ctx: Ctx,
  op: OperationNode,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, def] of Object.entries(op.varDefaults)) {
    if (vars[name] === undefined) vars[name] = coerce(def, vars);
  }
  const root: GqlObject = op.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = resolveSelections(ctx, root, op.selections, vars);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/**
 * Execute one GraphQL request body (a single operation object or a batch
 * array). Returns the response body object (or array) to send as JSON.
 */
export function handleGraphQL(store: Store, body: unknown): unknown {
  const runOne = (item: unknown): Record<string, unknown> => {
    const ctx: Ctx = { store, errors: [] };
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { data: null, errors: [{ message: 'Request body must be an object with a query string.' }] };
    }
    const query = (item as Record<string, unknown>).query;
    const variables = (item as Record<string, unknown>).variables;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: null, errors: [{ message: 'A query string is required.' }] };
    }
    let ops: OperationNode[];
    try {
      ops = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Failed to parse query.' }] };
    }
    if (ops.length === 0) {
      return { data: null, errors: [{ message: 'No operation found in query.' }] };
    }
    const vars = (variables !== null && typeof variables === 'object' && !Array.isArray(variables)
      ? variables
      : {}) as Record<string, unknown>;
    const op = ops[0] as OperationNode;
    return executeOperation(ctx, op, vars);
  };
  if (Array.isArray(body)) return body.map(runOne);
  return runOne(body);
}

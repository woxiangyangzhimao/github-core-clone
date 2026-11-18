# forge — a GitHub-compatible git forge in one Node process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/woxiangyangzhimao/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/woxiangyangzhimao/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A from-scratch reimplementation of the GitHub surface the `github-core-clone-01`
bounty asks for: smart-HTTP git clone/push, the REST v3 API, GraphQL (v4) and
MCP tools. One process, in-memory storage, Node standard library only — no git
binary, no package manager, no external service.

## What it implements

- **Git smart HTTP** (`/{owner}/{repo}.git`): protocol v2 `ls-refs` and `fetch`
  (with shallow/deepen), protocol v0 `upload-pack` and `receive-pack` with
  `report-status` + `side-band-64k`. Packs are built and parsed here (SHA-1
  objects, OFS/REF deltas on read, no deltas on write). Fast-forward rules
  per ref, mixed ok/ng reports, non-fast-forward refused with reason
  `non-fast-forward`.
- **REST v3** (`/api/v3`): repositories (create/read/patch/delete, branches,
  commits, git refs), contents (create/read/update/delete with base64 blobs),
  labels, issues (create/list/get/patch, comments), pull requests (create/list/
  get/files, squash merge with conflict detection → 405).
- **GraphQL** (`POST /api/graphql`): `viewer`, `repository` (fields, issues,
  pullRequests, cursored pagination), `node(id:)`, `__type` introspection for
  Issue / PullRequest / Repository / SearchType, mutations `createIssue`,
  `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`, and
  batched operation arrays. Global ids are opaque base64 values.
- **MCP** (`POST /mcp`): Streamable HTTP, modern `server/discover`
  (2026-07-28) with the legacy `initialize` handshake as fallback; tools
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`, sharing the store with REST.

Authentication: every API call must carry
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same value the environment
sets); without it the answer is 401. `GET /healthz` answers 200 `{"ok":true}`.

## How to run

Requires Node 22+ (uses only the standard library; no install step).

```sh
# Local run for the kit's runner (port pinned, token of your choice):
MAKEFUN_SHOP_TOKEN=secret MAKEFUN_PORT=18080 node --experimental-strip-types main.ts

# In the trial environment, the entry registers itself instead:
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=http://127.0.0.1:8080 node --experimental-strip-types main.ts
```

The entry binds a temporary port, `POST`s `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, then polls `GET $MAKEFUN_ENV_URL/done` until the
suite reports `{"done": true}` and exits 0.

## Layout

- `main.ts` — lifecycle: listen → register → poll `/done` → exit.
- `src/app.ts` — HTTP routing, auth, `X-GitHub-Request-Id`.
- `src/git.ts` — SHA-1 objects, pkt-lines, pack build/parse (incl. deltas).
- `src/protocol.ts` — smart-HTTP upload-pack v2/v0 and receive-pack v0.
- `src/store.ts` — in-memory repositories, issues, pulls, trees and merges.
- `src/rest.ts` — REST v3 handlers.
- `src/graphql.ts` — GraphQL parser and executor.
- `src/mcp.ts` — MCP JSON-RPC handlers and the six tools.
- `contract.md` — the interface contract this was built against (read from
  the kit's conformance suite; no implementation code).

## Notes

- Timestamps in stored state are fixed to the trial's opening time
  (`MAKEFUN_TRIAL_NOW`, else `2026-11-14T10:00:00Z`), so two runs of one
  instance export identical bytes.
- The viewer identity is the trial token's owner (`adaiversen`, id 1000).

---

<sub>Entered on [make.fun](https://make.fun/?ref=bmjgj28y&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

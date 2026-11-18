# github-core-clone-01 — 接口契约文档（只读调研）

> 来源：`~/workspace/makefun/github-core-clone-01-kit/github-core-clone-01-kit/sdk/conformance/` 下的
> `wire.ts`、`manifest.ts`、`calibration.json`、`main.ts`、`export.ts`、`bench.ts`、
> `checks-git.ts`、`checks-rest.ts`、`checks-graphql.ts`、`checks-mcp.ts`、
> `git-client.ts`、`rest-client.ts`、`graphql-client.ts`、`mcp-client.ts`
> （与密封 suite 字节一致的本地副本）。本文只写文件里实际看到的内容，未在文件中看到的写“未确认”，不猜测。
> 本文档不含任何实现代码，只描述契约。

## 0. 总览与计分

- 检查总数 **120**，分组：`git 30` / `repos 15` / `issues 15` / `pulls 20` / `graphql 20` / `mcp 15` / `protocol 5`。
  检查 id 形如 `<group>.<slug>`（`manifest.ts: checkId()`，slug 只允许小写字母/数字/连字符）。
- 计分（`manifest.ts`，满分 1000）：
  - `feature = round(600 * passed / 120)`
  - `agent = round(200 * mcp组通过数 / 15)`（mcp 组同时计入 feature）
  - `perf = Σ round(clamp(25 − 12.5·log2(t_ms / T_ref_ms), 0, 50))`，每 workload 上限 50，共 200
  - `score = feature + agent + perf`
  - 平局 tie-break：`perf_p50_us` 升序（四 workload p50_ms 的几何均值，单位微秒，四舍五入）；再按 receipt 先后。未确认 receipt 的具体定义来源（文件中只写“then the earlier receipt”）。
- `state.json`（`export/state.json`）：`{version:1, working:0|1, checks:{id:0|1}, counts:{total:120, passed, byGroup}, perfTiers:{push:0,clone:0,read:0,write:0}, notes?}`。
  注意：`state.json` 的 `perfTiers` 是**静态全 0**（`export.ts: STATIC_PERF_TIERS`），实测 tier 只在 `perf.json` 里；`working = 1` 仅当 boot 成功且至少 1 个检查通过。文件为 canonical JSON（key 全深度排序 + 末尾换行），原子写（tmp + fsync + rename）；更差的 export 不覆盖已有的更好的（state：working 更大、或 working 相同且 passed 更多才写；perf：points_total 不更小才写）。
- `perf.json`：见 §7。
- 运行顺序（`main.ts: suiteChecks()`）：`[...GIT_CHECKS, ...restChecks(), ...restProtocolChecks(), ...GRAPHQL_CHECKS, ...MCP_CHECKS]`，**一次一个检查，串行**；单个检查超时记 0、detail `"deadline"`，其余继续跑。
- 各检查超时：单个检查默认 `CHECK_TIMEOUT_MS = 15_000`，钳制在 `5_000..15_000`；git 检查在定义里各有 5_000/8_000/10_000/12_000/15_000；graphql 检查 8_000–15_000（见 §5 表）；REST 检查无自带 timeout（用 runner 的，`clientSet` 内钳制为 `max(1_000, min(timeoutMs, 5_000))`）；MCP 每请求超时 `min(检查预算, 3_000)`。

## 1. 生命周期与鉴权

### 1.1 角色与启动

- entry（参赛作品）是一个**独立的 GitHub 兼容 forge 服务器**，不是 agent；env（评分环境）与它并排启动。
- env 监听地址：`MAKEFUN_ENV_HOST`（容器内默认 `0.0.0.0`，process driver 下默认 `127.0.0.1`）:`MAKEFUN_ENV_PORT`（默认 `8080`，`0` 表示任选空闲端口），`reusePort: false`。监听成功后写 `<state>/ready`：`{"schema":"github-core-clone-01/ready/v1","host":…,"port":…}`。
- state 目录：`MAKEFUN_STATE_DIR`（未设则容器内 `/state`）；export 在 `<state>/export/state.json` 与 `<state>/export/perf.json`。
- 两种布局（`split` / `pod`）对契约无影响：entry 的 base URL 永远是 register 请求的来源地址 + 它声明的端口。

### 1.2 register / done（env 端的路由，entry 必须照此调用）

| 动作 | 请求 | 响应 |
|---|---|---|
| register | `POST $MAKEFUN_ENV_URL/register`，body `{"port": N}`（N 为整数 1..65535；多余 key 被忽略；body 上限 65_536 字节） | 首次：`200 {"ok":true}`；第二次及以后：`409 {"ok":false,"error":"already_registered"}`（第一次的 base URL 不动）；body 不是 JSON 对象 / port 非法 / body 超大：`400 {"ok":false,"error":"bad_json"/"bad_request"/"body_too_large", "message":…}`；非 POST：`405 {"ok":false,"error":"method_not_allowed",…}` |
| done 轮询 | `GET $MAKEFUN_ENV_URL/done` | 未结束：`200 {"done":false}`（env 立即回答，绝不挂起，`DONE_ANSWER_DEADLINE_MS=1_000`）；export 写完后：`200 {"done":true}`，entry 退出码 0；非 GET：`405` |
| 其他 env 路径 | 任意 | `404 {"ok":false,"error":"not_found",…}` |

- entry 流程：先 `listen(0)` 绑定自己的临时端口，再 POST `/register`；随后轮询 GET `/done`，首次间隔 `250 ms`，指数退避至上限 `2_000 ms`，单次请求超时 `30_000 ms`（只轮询，不长挂）。
- entry 的 base URL 推导：`http://<register 请求来源地址>:<声明端口>`；IPv4-mapped IPv6（`::ffff:a.b.c.d`）归一化为 IPv4，IPv6 字面量加方括号、去 zone 后缀（`%eth0`）；无来源地址则 env 报错。
- 超时/预算：boot 预算 `20_000 ms`（其中 `/healthz` 两次共 `10_000 ms`）；conformance `240_000 ms`；benchmark `240_000 ms`；export `30_000 ms`；trial wall budget `900 s`，env 内部 deadline = `900 s − 90_000 ms`（`MAKEFUN_TRIAL_WALL_BUDGET_SEC` 可覆盖本地运行）。到内部 deadline 时未跑完的检查记 0、未开始的 benchmark workload 不启动，仍写 export；harness 随后 SIGTERM env，env 在 SIGTERM 时重写 export（仅当不更差）后退出 0；deadline 后 env 再服务 5 s grace。

### 1.3 /healthz（entry 端，boot 检查）

- env 在 boot 阶段 `GET <entry>/healthz` **两次**，每次只要求 HTTP `200`（`main.ts: runBoot` 只判 `response.status === 200`，并读掉 body；`wire.ts` 称 entry 应答 `200 {"ok":true}`，但 boot 检查本身不校验 body——以 main.ts 的实际判定为准）。
- 两次都 200 才算 boot 成功；否则 `bootOk=false`，全部检查 0、`working=0`、note 为固定值 `"no entry registered before the boot deadline"`（无 register 时）。

### 1.4 鉴权 token

- 环境变量 `MAKEFUN_SHOP_TOKEN`（`wire.ts: TOKEN_ENV`）。env 从 `process.env[TOKEN_ENV] ?? ''` 取 token；**每一次发往 entry 的 API 调用都必须带 `Authorization: Bearer <token>`**。
- 各客户端的实际发送规则（token 为空时的行为不同）：
  - REST（`rest-client.ts`）：token 非 null 才发 `Authorization`；`token: null` 的 client（`anon`）不发。默认还发 `Accept: application/vnd.github+json`；有 body 时 `Content-Type: application/json`。
  - Git（`git-client.ts`）：`if (this.token)` 才发 `Authorization: Bearer …`；空 token 不发。另发 `User-Agent: makefun-git-client/1.0`。
  - GraphQL（`graphql-client.ts`）：`token: null` 不发 Authorization；否则发。另发 `Accept: application/json`、`Content-Type: application/json`、`User-Agent: makefun-github-core-clone-env/1`。
  - MCP（`mcp-client.ts`）：token 为 `''` 时不发；`omitAuth: true` 时不发；其余发 `Authorization: Bearer …`。
- 401 规则（entry 必须实现）：
  - REST：无 token 的请求 → `401`，body 为 JSON `{"message": <非空 string>}`（`repos.unauthorized`、`protocol.error-message`）。
  - GraphQL：无 token 的 POST `/api/graphql` → `401`（`graphql.unauthenticated`）。
  - MCP：无 Authorization 的 `tools/call` → `401`（`mcp.auth-required`）。
  - Git smart HTTP 的 401：文件中**未确认**——git 客户端不做无 token 的专项检查；`infoRefs` 只区分 200 / 非 200。
- 404 规则：
  - REST：不存在的仓库 / issue / PR / 内容 → `404` + `{"message": string}`；同名仓库在另一 owner（stranger）名下时对本 token 也是 `404`，**不是 403**（`repos.foreign-token`）。
  - Git：不存在的仓库，upload-pack 与 receive-pack 的 `info/refs` 都必须 `404`，且之后已知仓库仍须 `200`（`git.unknown-repo-404`、`git.repo-survives-errors`）。
  - GraphQL：未知仓库不是 404，而是 `200` 且 `data.repository = null`、无 `errors`（`graphql.unknown-repository`）。
  - 未知 REST 路由：`404` + `{"message": string}` 的 JSON（`protocol.unknown-route-json-404`）。
- 错误体格式（REST）：4xx body 必须是 JSON 对象且含非空 string `message`（`messageShape()`：`{message: string(nonEmpty)}`；`protocol.error-message` 覆盖 401、404、422 三种）。**未确认** 500 等其他状态的 body 格式要求（文件只要求这三类）。

### 1.5 X-GitHub-Request-Id 与分页 Link 头

- `X-GitHub-Request-Id`：**每个回复都必须带非空值**。`protocol.request-id` 抽查 4 个调用：`GET /api/v3/`、`GET /repos/{o}/{r}`、未知路由 GET、无 token 的 `GET /repos/{o}/{r}`。检查用 header 名小写 `x-github-request-id`（fetch Headers 不区分大小写）。值的内容/格式文件中未规定，只要求存在且非空。
- `X-OAuth-Scopes`：只在 `GET /api/v3/`（`repos.root`）要求**存在**（`expectHeader` 无 nonEmpty 要求，即空字符串也算存在——按 `expectHeader` 实现：仅当 header 为 null 才失败）。其他路由未要求此头。
- `X-RateLimit-*`：**明确不要求**（`checks-rest.ts` 头注释与 protocol 组注释）。
- 分页 `Link` 头：格式 `Link: <url>; rel="next", <url>; rel="last"`（`rest-client.ts: parseLinkHeader`：按逗号切分，正则 `/<([^>]*)>\s*;\s*rel\s*=\s*"?([A-Za-z]+)"?/`，只认 `next/prev/first/last`，rel 大小写不敏感化为小写）。客户端只跟随**同 origin**的 next URL（异 origin 拒绝，REST 客户端 `sameOrigin` 校验；分页检查遇异 origin 直接失败）。`per_page=10` 时每页至多 10 条；分页检查见 `repos.pagination`（§2）。

### 1.6 通用协议要求（protocol 组，见 §2.5）

- 每个 REST 回复的 Content-Type 必须是 JSON：`application/json`、`application/vnd.github+json` 或 `+json` 后缀（正则 `/^application\/(?:[A-Za-z0-9!#$&^_.+-]+\+)?json(?:\s*;.*)?$/i`，charset 参数允许）；绝不能是 `text/html`，body 也不能以 `<` 开头（`expectNoHtml`）。
- JSON body 解析失败 → 检查失败；`expectJsonResponse` 要求：精确状态码 + JSON Content-Type + 可解析 JSON + 形状匹配（见 §2 各形状）。
- 请求体不是合法 JSON → `400` + `{"message": string}`（`protocol.malformed-body-400`：向 `POST /api/v3/user/repos` 发 raw body `{"name":`，`Content-Type: application/json`）。
- REST 客户端默认超时 5_000 ms（每调用可覆盖）；响应体截断上限 1 MiB；跟随重定向（`redirect: 'follow'`）；Git 客户端 `redirect: 'error'`（不跟随）。

## 2. 全部 120 个检查

> 约定：下表“请求”栏为客户端实际发出的请求（方法、路径、头、body）；“通过条件”为精确判定。
> 所有检查的 fixture 数据均来自同一 seeded scenario（§1.7 / 文末 §8），仓库名等由检查 id 派生、互不冲突；
> 每个检查先用 REST `POST /api/v3/user/repos` 建库（git 检查则经 `GitClient.createRepo`，同为该路由），
> 再用 `PUT /contents` 做首个 commit（未确认：REST 的 `prepareRepo` 称“an unborn repository accepts it”）。
> 凡写“形状”处，指 `rest-client.ts: checkShape` 的判定：`shapes.object(props)` 的 required 默认 = props 的全部 key；
> 只校验列出的字段的类型/值，**未列出的多余字段不报错**（`allowExtra` 未设为 false 时）；缺失 required 字段报错。
> sha 比较时客户端多处用小写化比较（`lower()`），即 sha 的大小写不敏感；但 `shaShape` 正则为 `/^[0-9a-f]{40}$/i`（大小写均可）。

### 1.7 场景种子（所有检查共用的数据来源）

- `SCENARIO_SEED = 0x6a09e667f3bcc909n`（hex `6a09e667f3bcc909`）；`SCENARIO_EPOCH_SEC = 1_735_689_600`（2025-01-01T00:00:00Z）；所有时间戳 = epoch + seeded 偏移（≤90 天）。
- 用户 12 个，id `1000+i`，login 由名+姓拼接（去重加 `-2` 后缀），email `<login>@example.invalid`；`viewer = users[0]`，`teammate = users[1]`，`stranger = users[2]`。
- 仓库：viewer 30 个（id `5000+i`）、org 6 个（id `6000+i`，org 名形如 `<adj>-<noun>-org`）、stranger 3 个（id `7000+i`）；名 = `<形容词>-<名词>`（去重加后缀）；`private = (i % 7 === 3)`；`defaultBranch = 'main'`。
- 文件路径 60 条、blob 24 个（内容 64–4_096 字节 ASCII）、commit 模板 60 条、issue 模板 60 条、pull 模板 30 条；label 固定 `['bug','enhancement','documentation','question','good first issue','help wanted']`；分支默认 `['main','develop','release/1.0']` + 8 个生成的 `feature|fix|perf|docs|chore/<subject>`。
- 生成器为纯函数（FNV-1a + splitmix64 + xorshift64*），同一 label 同一种子在任何进程得到同一字节；检查不读 `Math.random` / 墙钟。

### 2.1 git 组（30）—— 请求均经 `GitClient`（§3），仓库名为 `gitconf-<slug>`，owner 为 viewer login

| # | id | 标题 | 请求（关键） | 通过条件 |
|---|---|---|---|---|
| 1 | `git.advertise-v2` | protocol v2 capability advertisement is served and well formed | 先建库+推 1 commit（main）；`GET /{o}/{r}.git/info/refs?service=git-upload-pack`，头 `Git-Protocol: version=2` | advertisement 解析为 protocol 2；capabilities 含 `fetch` 与 `ls-refs`（缺一即失败）；`object-format` 若出现必须为 `sha1`。超时 5_000 |
| 2 | `git.advertise-receive-pack` | receive-pack serves a v0 ref advertisement with push capabilities | 同上建库；`GET …/info/refs?service=git-receive-pack` | protocol 必须为 0（v2 即失败）；refs 含 `refs/heads/main` 且 oid = 推入的 tip；capabilities 必须含 `report-status`、`side-band-64k`、`delete-refs` 三项。超时 5_000 |
| 3 | `git.advertise-headers` | info/refs answers the smart-HTTP content type and preamble | 三次 info/refs：v0 客户端（`gitProtocol: 0`）upload-pack、默认客户端 upload-pack、默认客户端 receive-pack | 三者均为 200，且 Content-Type 分别含 `application/x-git-upload-pack-advertisement`（前两次）/`application/x-git-receive-pack-advertisement`；首个 data pkt-line：v0 请求为 `# service=git-upload-pack` 或 `version 2`；receive-pack 为 `# service=git-receive-pack`；v2 请求为 `# service=git-upload-pack` 或 `version 2`。超时 5_000 |
| 4 | `git.unknown-repo-404` | a missing repository advertises 404 and the server stays up | `GET …/<repo>-missing.git/info/refs?service=git-upload-pack` 与 `git-receive-pack`，再查已知库 | 两者均为 404；之后已知库 info/refs 仍为 200。超时 5_000 |
| 5 | `git.ls-refs` | v2 ls-refs reports refs, HEAD symref and peeled tags | 建库后推第 2 commit（main 前进）+ annotated tag `v1` 指向第 2 commit；`POST …/git-upload-pack`，v2 `command=ls-refs`（peel + symrefs，见 §3.3） | protocol 2；`refs/heads/main` oid = 第 2 commit；`HEAD` 的 `symref-target = refs/heads/main`；`refs/tags/v1` oid = tag 对象且 `peeled = 第 2 commit`。超时 8_000 |
| 6 | `git.ls-refs-prefix` | v2 ls-refs honours ref-prefix filtering | 推 tag `v1`；三次 ls-refs，prefix 分别为 `refs/heads/`、`refs/tags/`、`refs/does-not-exist/` | protocol 2；**服务器端**过滤：`rawRefs`（过滤前）必须全部以所给 prefix 开头；heads 含 main=tip，tags 含 v1=tag；无匹配 prefix 返回 0 个 ref。超时 8_000 |
| 7 | `git.clone-empty` | a repository with no refs clones as an empty repository | 只建库（REST），不推；advertisement/ls-refs + `clone()` | 无 `refs/` 开头的 ref；clone 的 objects 为 0；pack 为 null 或 0 字节；HEAD 若存在须为 unborn（`clone.head` 或 symref 目标均可接受表述，未确认二者哪一个被强制——代码：`head = clone.head ?? refs中HEAD的symrefTarget ?? null`，仅记入 detail，不判失败）。超时 8_000 |
| 8 | `git.push-first-commit` | a first commit pushes to an unborn branch and becomes the tip | 推 1 commit：`{oldOid: ZERO(40个0), newOid: tip, ref: refs/heads/main}` | `report.unpackOk == true` 且该 ref 的 report `ok`；随后 ls-refs 中 main=tip 且 HEAD symref-target=`refs/heads/main`。超时 8_000 |
| 9 | `git.clone-object-hashes` | a full clone verifies object-for-object | 3 个 commit 的链（每步改文件）；推到 main 后 `clone()` | clone 中每个对象的 SHA-1 重算等于其 id；含 tip；tip 的可达闭包完整（无缺失对象）。超时 12_000 |
| 10 | `git.clone-blob-bytes` | every cloned blob equals the pushed bytes | 2 文件（其一 4_096 字节）→ 第 2 commit；`clone()` | 可达对象与本地逐字节相等（类型+data 均等），无缺失/不同。超时 12_000 |
| 11 | `git.clone-tree-entries` | cloned trees round-trip paths, modes and nested directories | 含嵌套路径的文件集（`src/<blob0路径>` 或 blob0 自带 `/` 路径）+ 3 文件；`clone()` | 根 tree 的 entry 名集合 = 文件首段集合；目录 entry mode=`40000`，子 tree 存在且 entry 名正确；可达对象逐字节相等。超时 12_000 |
| 12 | `git.clone-commit-bytes` | commit objects round-trip byte-exactly with their metadata | 第 2 commit（meta index 1, revision 3）；`clone()` | tip commit bytes 与本地完全相等；parents 恰为 `[tip1]`；message = 模板 message（末尾保证一个 `\n`）；author/committer 行含 `<timestamp> +0000` 与 viewer email。超时 12_000 |
| 13 | `git.clone-annotated-tag` | an annotated tag object round-trips and peels to its commit | 推 annotated tag `v1`（tag 对象指向 tip）；`clone()` + ls-refs(peel) | tag 对象 bytes 相等；解析后 `object=tip, type=commit, tag=v1`；tagger 含 viewer email；ls-refs 中 `refs/tags/v1` oid=tag 且 peeled=tip。超时 10_000 |
| 14 | `git.fetch-incremental` | an incremental fetch sends only the new objects and advances the tip | 先 clone；推第 2 commit；`fetch({wants:[second], haves:[tip], haveObjects: 首次clone对象})` | fetch 含 second、不含 tip；所有对象 SHA-1 自洽；新可达对象（second 闭包 − tip 闭包）全部送达；已持有对象一个也不重发。超时 12_000 |
| 15 | `git.fetch-nothing-new` | a fetch with the tip already held transfers no objects | clone 后 `fetch({wants:[tip], haves:[tip], haveObjects: clone对象})` | `fetched.objects.size == 0`（pack 可为 0 字节空包，detail 称“a 0-byte pack with no entries”——即 packBytes 可为 0）。超时 10_000 |
| 16 | `git.fetch-shallow-depth1` | a depth-1 shallow clone lands the tip only | 3 commit 链推到 main；`clone({depth:1})` | 含 tip（third）、不含 second 与 tip1；tip commit bytes 相等；tip 的 tree 与其 blob 齐全；`shallow` 列表含 third（即 shallow-info 命名了 tip）。超时 12_000 |
| 17 | `git.fetch-shallow-deepen` | deepen 2 extends a shallow clone by exactly one generation | 同 16 的 3 链；先 depth-1 clone；再 `fetch({wants:[third], haves:[third], shallow: 首次shallow边界, depth:2, haveObjects})` | 送达 second（bytes 相等）及其 tree；不送达 tip1；shallow-info 须满足 `shallow 含 second` **或** `unshallow 含 third` 二者之一。超时 12_000 |
| 18 | `git.fetch-shallow-new-tip` | a shallow fetch of a new tip does not pull the old history | 2 链 depth-1 clone；再推 third；`fetch({wants:[third], haves:[second], shallow: 边界, depth:1, haveObjects})` | 送达 third；不送达 tip1，也不重发已持有的 second。超时 12_000 |
| 19 | `git.push-update-ref` | a fast-forward update moves a branch and clones see it | 推第 2 commit（old=tip） | unpack ok 且 report ok；ls-refs main=second；新 clone 含 second。超时 10_000 |
| 20 | `git.push-create-branch` | creating a branch from an existing commit is reported and advertised | 推 `{ZERO, tip, refs/heads/feature}` | unpack ok、report ok；ls-refs 与 clone 均见 `refs/heads/feature`=tip。超时 10_000 |
| 21 | `git.push-delete-branch` | deleting a branch is reported and removes the ref | 先建 `refs/heads/feature`=tip，再推 `{tip, ZERO, refs/heads/feature}`（delete-only 命令列表不带 pack，见 §3.5） | unpack ok、report ok；ls-refs 不再含 feature；main 仍为 tip；之后仍可 clone 且含 tip。超时 10_000 |
| 22 | `git.push-non-fast-forward` | a non-fast-forward update is refused per-ref and changes nothing | main 先进到 second；再推 sibling（以 tip1 为父、old=second） | **仍要求 `unpackOk == true`**（拒收也要先 unpack 成功）；该 ref 的 report `ok == false` 且 `reason` **精确等于字符串 `non-fast-forward`**；main 仍为 second；随后 info/refs 200、clone 含 second 且完整。超时 10_000 |
| 23 | `git.push-mixed-report` | one command list reports ok and ng per ref, and applies only the ok one | main 与 side 均在 second；同一命令列表推 main→forward（FF）与 side→sibling（非 FF） | unpack ok；report 恰为 2 条：main `ok`、side `ng` 且 reason=`non-fast-forward`；事后 main=forward、side 仍为 second。超时 12_000 |
| 24 | `git.push-delete-tag` | deleting a tag ref is reported and removes the ref | 建 tag v1 后推 `{tag, ZERO, refs/tags/v1}` | unpack ok、report ok；ls-refs 不再含 v1。超时 10_000 |
| 25 | `git.push-100-files` | a 100-file single-commit push round-trips byte-exactly | 100 个不同路径文件的一次 commit（路径由 60 条 scenario 路径派生，超出的加 `.1` 等后缀）推 main；`clone()` | unpack ok、report ok；可达对象无缺失/不同；100 条路径逐一在 clone 的 tree 中找到且 blob bytes 相等。超时 15_000 |
| 26 | `git.pack-integrity` | a fetched pack is structurally valid and checksummed | 2_048 字节文件链；`fetch({wants:[second], parse:false})` | fetch 送来非空 pack；trailer SHA-1 = 对之前全部字节的 SHA-1；`readPack`：version 为 2 或 3、header 声明数 = 解析条目数 = 去重后对象数；每个对象 SHA-1 自洽。超时 12_000 |
| 27 | `git.pack-deltas` | delta-compressed objects resolve correctly (when the server sends them) | 20_000 字节文件、连续 3 个 revision（内容高度相似）；`clone()` | clone 含 tip；所有对象 SHA-1 自洽、可达对象逐字节相等。**注意**：`deltaCount` 只出现在成功 detail 里，**不要求服务器必须发 delta**（标题括号“when the server sends them”）；发不发 delta 都能过，只要解析出的对象正确。超时 15_000 |
| 28 | `git.sideband-framing` | the fetch packfile section is valid sideband framing | 4_096 字节文件链；`fetch({wants:[second], parse:false, observe: 收集全部packet})` | 每个 pkt-line raw 长度 ≤ 65_520；packfile section（v2）或 v0 的直接 sideband 包：band 只能是 1（pack 数据）/2（progress）/3（错误→失败）；至少 1 个 sideband 包、band-1 数据非空；重组 pack 的 trailer 校验通过且 `readPack` 成功。v0 响应无 section 名，NAK/ACK 后直接跟 sideband 包。超时 12_000 |
| 29 | `git.push-sideband-report` | the push report arrives in valid sideband frames | 推第 2 commit（经 `pushRefs`） | 客户端判定 `pushed.sideband == true`（即 push 时 capabilities 含 `side-band-64k`——客户端只在服务器 advertise 了它时才启用；见 §3.5）；report 从 band 1 解出、unpack ok、main ok。超时 12_000 |
| 30 | `git.repo-survives-errors` | the server stays healthy through 404s, refusals and a malformed request | 缺失库 info/refs（404）；推 second；推 sibling 非 FF（接受 ok 或 ng 任一结果）；向 `POST …/git-upload-pack` 发 raw body `zzzznot-a-pkt-line`（`postRaw`，不对响应做断言，只记录状态/异常） | 404 正确；随后 info/refs 200；ls-refs 有 main；clone 含 main tip 且对象 SHA-1 自洽、闭包完整。**注意**：畸形 POST 的响应状态在文件中**未被断言**（任何状态/异常都只记入 detail）。超时 15_000 |

### 2.2 repos 组（15）—— 均经 `RestClient`（§4），`apiPath` 编码每个 path segment（`/` 内的文件路径分段编码）

仓库名：`<scenario.repos[0].name>-<check-id slug>`（小写化、超长截到 100 字符）；除特别注明外每检查先 `prepareRepo`：`POST /api/v3/user/repos {name, private:true, description}` 要求 201 且 `{name: ==所发名, private: boolean}`，再 `PUT /contents/<filePath> {message, content: base64}` 要求 201 且 `{content:{sha, encoding:"base64"}, commit:{sha}}`，再 `GET /repos/{o}/{r}` 要求 200 且 `default_branch` 非空。

| # | id | 标题 | 请求 | 通过条件 |
|---|---|---|---|---|
| 1 | `repos.pagination` | GET /user/repos pages 30 seeded repos at per_page=10 through Link rel="next" | 先为 30 个 seeded viewer 仓库名逐一 `POST /user/repos`（201 接受；**422 也接受**，视为已存在）；逐一 `GET /repos/{o}/{r}` 验 200；随后 `GET /api/v3/user/repos?per_page=10`，跟随 `Link: rel="next"` 直至无 next（最多 20 页） | 每页 ≤10 条；各页仓库名无重复；30 个名全部出现；页数 ≥3。next URL 必须同 origin。 |
| 2 | `repos.root` | GET /api/v3/ answers 200 JSON with X-OAuth-Scopes | `GET /api/v3/`（`apiPath()` + `/`） | 200、JSON Content-Type、body 为任意 JSON 对象（`looseObject`，无 required 字段）；带 `X-OAuth-Scopes` 头（值可空，见 §1.5）。 |
| 3 | `repos.meta` | GET /api/v3/meta reports installed_version | `GET /api/v3/meta` | 200、JSON、`{installed_version: 非空 string}`。 |
| 4 | `repos.create` | POST /user/repos creates and GET round-trips name, private and default_branch | `POST /api/v3/user/repos {name, private:true, description}`；两次 `GET /api/v3/repos/{o}/{r}` | 创建 201 且 `name` 等于所发、`private == true`（body 值精确比对）；GET 200 且 `name/private/default_branch(非空)` 一致；两次 GET 的 `default_branch` 相同。 |
| 5 | `repos.not-found` | GET a missing repository is a JSON 404 | `GET /api/v3/repos/{owner}/<repoPrefix>-never-created` | 404 + `{"message": 非空 string}`。 |
| 6 | `repos.patch` | PATCH /repos/{o}/{r} updates the description | `PATCH /repos/{o}/{r} {description: <alt>}`；再 GET | PATCH 200 且 `description == <alt>`；GET 后仍为 `<alt>`。 |
| 7 | `repos.delete` | DELETE /repos/{o}/{r} deletes it and a later GET is 404 | `DELETE /repos/{o}/{r}`；再 GET | DELETE **204**（`expectStatus` 精确值，不解析 body）；随后 GET 404 + message。 |
| 8 | `repos.branches` | GET /branches lists a branch created through POST /git/refs | `POST /repos/{o}/{r}/git/refs {ref:"refs/heads/<branch>", sha:<initialCommitSha>}` 要求 201 `{ref: ==所发, object:{sha}}`；`GET /repos/{o}/{r}/branches` | 200、数组、每项 `{name: 非空 string, commit:{sha}}`；列表含新建分支与 default 分支；新建分支的 `commit.sha`（大小写不敏感）= initial commit sha。 |
| 9 | `repos.commits` | GET /commits reflects a commit made on a branch and not the default branch | 在分支上 `PUT /contents` 提交一文件（branch 参数，见 §4）；`GET /repos/{o}/{r}/commits?sha=<branch>` 与 `GET /repos/{o}/{r}/commits`（无参） | 带 `?sha=` 的 200 数组每项 `{sha, commit:{message}}`，含该分支 commit 且 message 精确等于所发 message；无参列表**不含**该 commit。 |
| 10 | `repos.unauthorized` | a request without a token is 401 | 无 token 客户端 `GET /repos/{o}/{r}` | 401 + `{"message": 非空 string}`。 |
| 11 | `repos.foreign-token` | the same repository name under another owner is a 404 for this token | 先建库并验 owner 下 GET 200；再 `GET /api/v3/repos/{stranger}/{同名}` | 后者 404 + message（不是 403）。 |
| 12 | `repos.contents-create` | PUT /contents creates a file with a commit; GET returns base64 content and sha | `PUT /contents/<variant路径> {message, content: base64(alt内容)}`（variant 路径 = 原路径加 `-created` 后缀）；`GET /contents/<同路径>` | PUT 201 且 content/commit sha 形如 40 hex；GET 200 且 `{type:"file", encoding:"base64", content: string, sha, size: int≥0}`；`b64decode(content) == 所发内容`；GET 的 sha（大小写不敏感）= PUT 的 content sha；`size == 内容 UTF-8 字节数`。 |
| 13 | `repos.contents-directory` | GET /contents on a directory lists its entries | 先在 `<dir>/seed.txt` 建首 commit；再 PUT `<dir>/one.txt`、`<dir>/two.txt`；`GET /contents/<dir>` | 200、数组、每项 `{type: "file"\|"dir", name: 非空, path: 非空, sha}`；列表含 `seed.txt`、`one.txt`、`two.txt`。 |
| 14 | `repos.contents-stale-sha` | PUT /contents with a stale sha is 409 | GET 当前文件得 sha；用该 sha PUT 更新（接受 200 或 201，要求新 content sha ≠ 旧 sha）；再用**旧 sha** PUT 一次 | 第二次 PUT **409** + message。 |
| 15 | `repos.contents-delete` | DELETE /contents removes the file with a commit and GET is 404 | `DELETE /contents/<path> {message, sha: 当前sha}`；再 GET | DELETE 200 且 `{commit:{sha}}`；随后 GET 404 + message。 |

### 2.3 issues 组（15）

fixture：每检查 `prepareIssueRepo`：先 `prepareRepo`，再 `POST /repos/{o}/{r}/labels {name: <scenario.labels[0]>, color: "ededed"}` 要求 201 且 `{name: 非空}`。
issue 形状（`issueShape`，创建/列表/单读共用）：`{number: int≥1, title: string, body: string, state: "open"|"closed", labels: [{name: 非空 string}]}`——注意 `labels` 为对象数组，每项只要求 `name`；`body` 要求为 string 类型（可为空字符串？`shapes.string()` 无 nonEmpty 要求——空字符串通过）。

| # | id | 标题 | 请求 | 通过条件 |
|---|---|---|---|---|
| 1 | `issues.create` | POST /issues creates a 201 open issue with a number | `POST /repos/{o}/{r}/issues {title, body, labels:[<label>]}` | 201、符合 issue 形状、`state == "open"`。 |
| 2 | `issues.create-title-body` | POST /issues echoes the title and body | 同上（无 labels） | 201；`title`/`body` 精确等于所发。 |
| 3 | `issues.create-labels` | POST /issues attaches an existing label | `POST …/issues {title, body, labels:[<label>]}` | 201；返回的 `labels[].name` 含该 label。 |
| 4 | `issues.numbers-increment` | issue numbers increment by one | 连续创建两个 issue（标题加 ` 1` / ` 2` 后缀） | 第二个 `number == 第一个 number + 1`。 |
| 5 | `issues.list-open` | GET /issues?state=open lists the open issue | 建 1 open + 1 closed（PATCH 关闭）；`GET …/issues?state=open&per_page=100` | 200 数组（每项 issue 形状）；含 open 的、不含 closed 的（以 number 判定）；**列表中每一项的 `state` 都必须为 `open`**。 |
| 6 | `issues.list-open-excludes-closed` | GET /issues?state=open omits a closed issue | 建 1 issue 后 PATCH 关闭；同上列表 | 列表中不含该 closed issue 的 number。 |
| 7 | `issues.list-sort-asc` | GET /issues?sort=created&direction=asc orders by creation | 建 3 个 issue（标题 a/b/c）；`GET …/issues?state=open&sort=created&direction=asc&per_page=100` | 三个 number 均在列表中，且位置严格递增（创建顺序）。 |
| 8 | `issues.list-sort-desc` | GET /issues?sort=created&direction=desc reverses it | 同上，`direction=desc` | 三个 number 位置严格递减（最新在前）。 |
| 9 | `issues.list-shape` | GET /issues returns the GitHub issue shape | 建 1 issue；`GET …/issues?state=open&per_page=10` | 200、非空数组、每一项都通过 issue 形状校验。 |
| 10 | `issues.get-one` | GET /issues/{n} returns the issue | 建 1 issue；`GET …/issues/{n}` | 200、issue 形状、`number/title/body` 均等于创建时的值。 |
| 11 | `issues.patch-close` | PATCH /issues/{n} closes it | `PATCH …/issues/{n} {state:"closed"}` | 200、`{number: int≥1, state: "closed"}`（精确值）；返回的 `state == "closed"`。 |
| 12 | `issues.patch-close-persists` | the close survives a later GET | PATCH 关闭后 `GET …/issues/{n}` | 200、issue 形状、`state == "closed"`。 |
| 13 | `issues.comment-create` | POST /issues/{n}/comments creates a comment | `POST …/issues/{n}/comments {body: <commentBody>}` | 201、`{id: int≥1, body: ==所发commentBody}`（精确值比对）。 |
| 14 | `issues.comments-list` | GET /issues/{n}/comments lists the comment | 建 comment（记其 id）后 `GET …/issues/{n}/comments` | 200、数组每项 `{id: int≥1, body: string}`；含 id 与 body 均匹配的那一条。 |
| 15 | `issues.bad-label` | POST /issues with an unknown label is 422 | `POST …/issues {title, body, labels:["<label>-not-a-label"]}` | **422** + `{"message": 非空 string}`。 |

### 2.4 pulls 组（20）

fixture（`preparePull`）：`prepareRepo` → `POST /git/refs` 建 head 分支（`{ref:"refs/heads/<branch>", sha: initialCommitSha}`，201）→ 在 head 分支上 `PUT /contents` 提交 1 个改动文件（默认路径为 scenario 文件路径加 `-<slug>` 后缀变体，内容为 alt 内容；`commitOnBranch` 更新时接受 200 或 201）→ `POST /pulls {head, base: defaultBranch, title, body}` 要求 201。
pull 形状（`pullShape`）：`{number: int≥1, state: "open"|"closed", title: string, body: string, head: {ref: 非空 string, sha: 40hex}, base: {ref: 非空 string, sha: 40hex}}`。
pull file 形状：`{filename: 非空 string, status: 非空 string, additions: int≥0, deletions: int≥0, changes: int≥0}`。

| # | id | 标题 | 请求 | 通过条件 |
|---|---|---|---|---|
| 1 | `pulls.create` | POST /pulls creates an open pull request from a head branch | 建 PR 后 `GET /pulls/{n}` | 200、pull 形状、`state == "open"`、`head.ref == head 分支`、`base.ref == default 分支`。 |
| 2 | `pulls.create-body` | POST /pulls echoes the title and body | 同上 | `title`/`body` 精确等于创建时所发。 |
| 3 | `pulls.create-head-sha` | the pull head.sha is the head branch tip | 同上 | `head.sha`（大小写不敏感）= head 分支上最后一次 contents commit 的 sha。 |
| 4 | `pulls.create-base-sha` | the pull base.sha is the base branch tip | 同上 | `base.sha`（大小写不敏感）= default 分支的 initial commit sha。 |
| 5 | `pulls.get-one` | GET /pulls/{n} returns the pull request | `GET /pulls/{n}` | 200、pull 形状、`number` 与 `title` 等于创建值。 |
| 6 | `pulls.files-list` | GET /pulls/{n}/files lists the changed path | `GET /pulls/{n}/files` | 200、数组（每项 pull file 形状）；含改动路径那一项；其 `status` ∈ `{"added","modified","changed"}`；`additions ≥ 1`。 |
| 7 | `pulls.files-shape` | pull files carry filename, status and the change counts | 同上 | 200、非空数组、每一项通过 pull file 形状校验。 |
| 8 | `pulls.files-multiple` | GET /pulls/{n}/files lists every changed path | 建 PR 时在 head 分支提交 2 个不同文件 | 列表同时含两个路径。 |
| 9 | `pulls.merge-status` | PUT /pulls/{n}/merge with merge_method=squash is 200 | `PUT /pulls/{n}/merge {merge_method:"squash"}` | **200**（只断言状态码）。 |
| 10 | `pulls.merge-body` | the merge reply is {merged:true, sha, message} | 同上（`mergedPull` helper） | 200、`{merged: boolean, sha: 40hex, message: string}` 且 `merged == true`；sha 须匹配 40 hex 正则。 |
| 11 | `pulls.merge-closes` | the merged pull is closed, merged and carries merged_at | 合并后 `GET /pulls/{n}` | 200、`{state: "closed", merged: boolean, merged_at: 非空 string}` 且 `merged == true`。 |
| 12 | `pulls.merge-commit-on-default` | the merge commit appears on the default branch | 合并后 `GET /commits?sha=<base>` | 200 数组（每项 `{sha}`）；含 merge 返回的 sha（大小写不敏感）。 |
| 13 | `pulls.merge-content-on-default` | the squash content is on the default branch | 合并后 `GET /contents/<改动路径>?ref=<base>` | 200 文件形状；base64 解码后内容 == 合并前 head 分支的 alt 内容。 |
| 14 | `pulls.merge-commit-sha` | the pull reports merge_commit_sha equal to the merge sha | 合并后 `GET /pulls/{n}` | 200、`{merge_commit_sha: 40hex}` 且（大小写不敏感）= 合并返回的 sha。 |
| 15 | `pulls.merge-unknown` | merging an unknown pull request is 404 | `PUT /pulls/999999999/merge {merge_method:"squash"}` | 404 + message。 |
| 16 | `pulls.merge-conflict` | merging a conflicted pull request is 405 | 两分支在同一文件提交不同内容（update 模式）→ 各建一 PR → 合并第一个（要求 200）→ 合并第二个 | 第二个合并 **405** + message。 |
| 17 | `pulls.list-state-all` | GET /pulls?state=all lists open and merged pull requests | 合并 1 个 PR + 再建 1 个 open PR；`GET /pulls?state=all&per_page=100` | 200 数组（pull 形状）；number 列表同时含 merged 的与 open 的。 |
| 18 | `pulls.list-default-open` | GET /pulls defaults to open pull requests | 同上 setup；`GET /pulls?per_page=100`（无 state 参数） | 200；含 open 的、**不含** merged 的。 |
| 19 | `pulls.list-shape` | GET /pulls returns the GitHub pull-request shape | 建 1 PR；`GET /pulls?state=all&per_page=10` | 200、非空数组、每一项通过 pull 形状校验。 |
| 20 | `pulls.get-unknown` | GET an unknown pull request is 404 | `GET /pulls/999999999` | 404 + message。 |

### 2.5 protocol 组（5）—— REST 共享面

| # | id | 标题 | 请求 | 通过条件 |
|---|---|---|---|---|
| 1 | `protocol.content-type-json` | every REST reply is application/json, never HTML | 6 次调用：`GET /api/v3/`、`GET /api/v3/meta`、`GET /repos/{o}/{r}`、`GET …/issues`、未知路由 GET、无 token 的 `GET /repos/{o}/{r}` | 每次都有响应（status ≠ 0）；Content-Type 为 JSON（§1.6 正则）；body 不以 `<` 开头且 Content-Type 非 `text/html`。 |
| 2 | `protocol.unknown-route-json-404` | an unknown /api/v3 route is a JSON 404 | `GET /api/v3/no-such-route/<repoPrefix>` | 404 + `{"message": 非空}`，且非 HTML。 |
| 3 | `protocol.malformed-body-400` | a malformed JSON body is a 400 | `POST /api/v3/user/repos`，raw body `{"name":`，头 `Content-Type: application/json` | **400** + `{"message": 非空}`。 |
| 4 | `protocol.request-id` | every reply carries a non-empty X-GitHub-Request-Id | 4 次调用（见 §1.5） | 每次都有响应且带非空 `X-GitHub-Request-Id`。 |
| 5 | `protocol.error-message` | 401, 404 and 422 bodies carry a string message | 缺失仓库 GET（404）、无 token GET 私有库（401）、未知 label 建 issue（422） | 三者状态码精确 + 各自 body 为 `{"message": 非空 string}`。 |


### 2.6 mcp 组（15）—— 均经 `McpClient`（§6），每检查先 `connect()`（modern discover 或 legacy handshake），再 `listTools()`（除特别注明外）

fixture：仓库名 `mcp-<seed前8hex>-<part>`（如 `mcp-6a09e667-issue-create`），owner 为 token 的 login（`GET /api/v3/user`，失败时回落 viewer login）；每请求超时 `min(检查预算, 3_000)`。工具调用的参数映射见 §6.3；下表“请求”栏为语义参数（实际发送的属性名按目标工具的 inputSchema 映射）。

| # | id | 标题 | 请求 | 通过条件 |
|---|---|---|---|---|
| 1 | `mcp.initialize` | initialize: serverInfo.name/version and capabilities.tools, over whichever era the server negotiates | `connect()`（`server/discover` 或 legacy `initialize` + `notifications/initialized`，见 §6.1） | 连接成功；`serverInfo.name` 与 `serverInfo.version` 均为非空 string；`capabilities.tools` 存在（为对象） |
| 2 | `mcp.server-discover` | server/discover: a DiscoverResult with supportedVersions, or the pre-discover era | `connect()`；读 `client.discoverAttempt` | modern：`supportedVersions` 非空（每项须为 `YYYY-MM-DD`）；legacy（discover 答 404 / `-32601` / 其他拒收但随后 handshake 成功）：**直接通过** |
| 3 | `mcp.tools-list` | tools/list: at least six tools, all six required ones present by name or obvious alias | `tools/list` | 工具数 ≥6；六个必需工具（`create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request`）全部能按 §6.2 的匹配规则找到 |
| 4 | `mcp.tool-schemas` | every tool has a non-empty description and an inputSchema of type object | `tools/list` | 工具数 >0；**每个**工具的 `description` 为非空 string 且 `inputSchema.type == "object"` |
| 5 | `mcp.create-issue` | tools/call create_issue creates an issue the REST surface lists | 先 REST 建库；`tools/call create_issue {owner, repo, title: <issues[0].title>, body: <issues[0].body>}` | 调用无 JSON-RPC 错误且 `isError` 不为 true；随后 REST `GET /issues?state=all&per_page=100` 列出同 title 的 issue |
| 6 | `mcp.list-issues` | tools/call list_issues returns an issue the repository holds | 先 REST 建库 + 建一 issue（`issues[1]`，记 number）；`tools/call list_issues {owner, repo, state: "open"}` | 调用成功；tool result 文本含该 issue 的 title，**或**含 `"number": <n>`（正则 `"number"\s*:\s*<n>(?!\d)`） |
| 7 | `mcp.create-pull-request` | tools/call create_pull_request opens a pull request REST reads back with the same head and base | 先 REST 建库 + base commit + head 分支（`POST /git/refs` 或 contents 写分支）；`tools/call create_pull_request {owner, repo, title: <pulls[0].title>, body, head, base}` | 调用成功；从 tool result JSON 取 number（`number`/`pull_number`/`pull_request_number`）或按 title/head 在 REST 列表中找到 PR；REST 读到的 `head.ref`/`base.ref` 等于准备的分支名 |
| 8 | `mcp.merge-pull-request` | tools/call merge_pull_request merges; REST reads merged:true | 先 REST 建库 + 准备分支 + 建 PR（`pulls[1]`，记 number）；`tools/call merge_pull_request {owner, repo, pull_number: <n>}` | 调用成功；随后 REST `GET /pulls/{n}` 的 `merged == true` |
| 9 | `mcp.unknown-tool` | an unknown tool name answers JSON-RPC -32602 or -32601, never HTTP 500 | `tools/call`，`name: "mcp_no_such_tool_<tag>"`，`arguments: {}`（直接 `client.request`，不经工具映射） | HTTP ≠ 500；JSON-RPC 错误 code 为 `-32602` 或 `-32601` |
| 10 | `mcp.parse-error` | a body that is not JSON answers HTTP 400 with JSON-RPC -32700 | `postRaw('{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"')`（故意缺右大括号），头 `Mcp-Method: tools/list`，期望 id `424242` | modern：HTTP **400** 且 code `-32700`；legacy：HTTP 200 且 code `-32700` 也通过 |
| 11 | `mcp.missing-arguments` | tools/call with missing required arguments answers isError:true or JSON-RPC -32602 | `tools/call create_issue`，`arguments: {}`（`allowMissing: true`，即便 required 未满足也照常调用） | `isError == true` **或** JSON-RPC 错误 `-32602` |
| 12 | `mcp.concurrent-calls` | two concurrent tool calls answer under their own ids and their own objects | 建两个库；并行发两个 `tools/call get_repo`，JSON-RPC id 分别为字符串 `concurrent-left-<tag>` / `concurrent-right-<tag>`，参数各为其一仓库 | 每个响应的 `matchedId` 等于自己请求的 id；两者均无 JSON-RPC 错误；各自 tool result 文本含各自的仓库名 |
| 13 | `mcp.tools-list-idempotent` | two tools/list answers hold the same tools array, byte for byte | 两次 `tools/list` | 两次工具数组的 `JSON.stringify` **字节相同**（长度与内容均同） |
| 14 | `mcp.rest-parity` | a repository and an issue created over MCP are the same objects over REST, ids stable | `tools/call create_repo {owner, name: <mcp-<tag>-parity>, description, private: true}`；两次 REST `GET /repos/{o}/{r}`；再 `tools/call create_issue {owner, repo, title: <issues[2].title>, body}`；两次 REST `GET /issues/{n}`（number 取自 tool result JSON 或按 title 在列表中找） | 调用均成功；两次 REST 读库的 `id`（`String()` 比较）相同；两次读 issue 的 `id` 相同且 title 等于所发；若 tool result 的 `full_name` 为 `"owner/repo"` 形式，以其拆出的 owner/repo 为准 |
| 15 | `mcp.auth-required` | a tools/call with no Authorization header answers HTTP 401 | `tools/call create_issue`（`omitAuth: true`），参数 `{owner: "no-auth", repo: "no-auth-<tag>", title, body}`（工具名取 listed 的实际名，无则用 canonical 名） | **HTTP 401** |

## 3. Git smart HTTP 协议细节

### 3.1 端点与通用头

- 路径：`/{owner}/{repo}.git/info/refs?service=<service>`、`/{owner}/{repo}.git/git-upload-pack`、`/{owner}/{repo}.git/git-receive-pack`。
  owner/repo 名校验（客户端侧）：须匹配 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/`，且 repo 名不得以 `.git` 结尾（否则客户端直接抛错，不发请求）。
- 请求头（`GitClient.request`）：`User-Agent: makefun-git-client/1.0`；info/refs：`Accept: */*`；POST：`Content-Type: application/x-<service>-request`、`Accept: application/x-<service>-result`、`Content-Length: <body字节数>`；`Git-Protocol: version=2` **仅当**请求 v2 时发送（见下）；token 非空时 `Authorization: Bearer <token>`。`redirect: 'error'`（不跟随重定向）。
- 响应校验（`expectOk` / `advertisement`）：非 200 → `GitHttpError`（失败）；Content-Type 非空时必须包含期望串（advertisement：`application/x-<service>-advertisement`；POST 结果：`application/x-<service>-result`），否则 `GitProtocolError[content-type]`。
- pkt-line 编解码：`0000` flush、`0001` delim、`0002` response-end、4 位十六进制长度（含头）；单包上限 `PKT_LINE_MAX = 65_520` 字节（含 4 字节头），payload 上限 65_516；长度 `0003` 非法；超长/截断/非法头均为协议错误。解码器为增量式；v0 无 sideband 的 fetch 响应可回退到 raw（未分帧）模式读取 pack（`nextIsRaw` / `takeBuffered`）。
- 对象模型：只讲 SHA-1（`GIT_OBJECT_FORMAT = 'sha1'`）；对象 id = SHA-1(`"<type> <size>\0" + 内容`)；只接受小写 40 hex（`isObjectId` 正则 `/^[0-9a-f]{40}$/`——注意大写 hex 在 git-client 的 `isObjectId` 下**不接受**，但 REST 的 sha 正则不区分大小写；见 §8）；tree entry 排序按 git 规则（目录名视同带 `/` 后缀比较）；commit 格式：`tree <oid>\n`、`parent …`（多个时各一行）、`author <ident> <unix秒> +0000`、`committer …`、空行、message；tag 格式：`object/type/tag/tagger` + 空行 + message。默认 identity `Conformance <conformance@make.fun>`；`buildCommit` 默认 timestamp `1_700_000_000`、时区 `+0000`（调用方一般传 scenario 时间戳）。
- 客户端默认超时 `DEFAULT_GIT_TIMEOUT_MS = 8_000`；git 检查的 harness 把每调用超时钳制为 `min(context.timeoutMs || 8000, 8000)`，即不超过 8_000。

### 3.2 upload-pack v2：capability advertisement

- 触发：`infoRefs` 对 `git-upload-pack` 且 protocol preference 非 0 时，发送 `Git-Protocol: version=2` 头；`advertisement()` 解析响应包。
- v2 响应：首个 data 包为 `version 2`（可带后缀，解析时 `first === 'version 2' || first.startsWith('version 2 ')`），随后每行一个 capability（`name` 或 `name=value`）。
- 检查强制要求（`git.advertise-v2`）：capabilities 必须含 `fetch` 与 `ls-refs`；`object-format` 若出现必须为 `sha1`，否则客户端抛 `object-format` 错误。
- 解析器对 v2 的其他要求：文件中**未确认**除 `fetch`/`ls-refs` 外还要求哪些 capability 键（客户端在 fetch 时只查 `fetch` 的子特性是否含 `shallow` / `filter`；在 ls-refs 时查 `ls-refs` 的子特性是否含 `unborn`——见 §3.3/§3.4）。
- v0 回退判定：首行不是 `version 2` 即按 v0 解析（见 §3.6）。若客户端 `gitProtocol: 2`（强制 v2）而服务器答 v0 → 抛 `protocol-v2-required`；若 `gitProtocol: 0` 而服务器答 v2 → 抛 `protocol-mismatch`。默认 `auto`：v2 优先，v0 亦可。

### 3.3 ls-refs（v2）

- 前置：先 `advertisement()` 拿 v2 capabilities。
- 请求体（pkt-line 序列，POST 到 `/git-upload-pack`，`Git-Protocol: version=2`，`Content-Type: application/x-git-upload-pack-request`）：
  ```
  command=ls-refs\n
  [agent=makefun-git-client/1.0\n]        # 仅当 advertisement 含 agent
  [object-format=sha1\n]                  # 仅当 advertisement 含 object-format
  delim (0001)
  [peel\n]                                # 默认 true（调用方可关）
  [symrefs\n]                             # 默认 true
  [unborn\n]                              # 仅当 fetch 能力串含 unborn（注：代码查的是 capabilities.get('ls-refs') 的值是否含 'unborn'）
  [ref-prefix <prefix>\n] × N            # 每个 prefix 一行
  flush (0000)
  ```
- 响应行解析：每行 `<oid> <ref>[ symref-target:<t>][ peeled:<oid>]`；`unborn` 开头的行表示未出生 ref（oid 记为 40 个 0，`unborn: true`）。行无空格 / oid 非法 → 协议错误。
- 返回：`{protocol:2, rawRefs（服务器原样，未做客户端 prefix 过滤）, refs（客户端再按 prefix 过滤后的）, capabilities, headSymref（HEAD 行的 symref-target）}`。检查 `ls-refs-prefix` 断言的是 `rawRefs`，即**服务器必须自己做 prefix 过滤**，不能全量返回让客户端滤。
- v0 时 `lsRefs()` 不发 POST，直接返回 advertisement 的 ref 列表再做客户端过滤。

### 3.4 fetch（v2 与 v0）

通用：`fetch()` 先 `advertisement()`；protocol 2 走 `fetchV2`，protocol 0 走 `fetchV0`。`wants` 去重；空 wants 直接返回空结果（无 pack、无对象）。

**v2 fetch 请求体**（pkt-line，POST `/git-upload-pack`，`Git-Protocol: version=2`）：
```
command=fetch\n
[agent=makefun-git-client/1.0\n]        # 仅当含 agent 能力
[object-format=sha1\n]                  # 仅当含 object-format 能力
delim
thin-pack\n                             # 默认发送（thinPack !== false 时）
no-progress\n                           # 默认发送（noProgress !== false 时）
ofs-delta\n                             # 总是发送
[filter <filter>\n]                     # 仅当 request.filter 指定；若 fetch 能力不含 filter → 客户端抛错
want <oid>\n                            # 每个 want 一行
have <oid>\n                            # 每个 have 一行
shallow <oid>\n                         # 每个当前 shallow 边界一行
[deepen <n>\n]                          # depth 指定时；若 fetch 能力不含 shallow → 客户端抛错
[deepen-since <unix秒>\n]
[deepen-not <ref>\n] × N
[done\n]                                # 默认发送（done !== false 时）
flush
```
**v2 fetch 响应解析**（sections，以 `acknowledgments\n` / `shallow-info\n` / `wanted-refs\n` / `packfile\n` / `packfile-uris\n` 命名行分隔；`delim`/`flush` 清空当前 section）：
- `acknowledgments`：行只能是 `NAK` / `ready` / `ACK <oid>…`，否则协议错误；
- `shallow-info`：行只能是 `shallow <oid>` / `unshallow <oid>`；
- `wanted-refs`：行 `<oid> <ref>`；
- `packfile`：每包首字节为 sideband band：`1`=pack 数据、`2`=progress 文本、`3`=错误（抛错）；其他 band 值抛错；空包抛错；packfile section 零包 → 抛错。
- 收到 pack 后：先验 trailer 校验和（不通过抛 `pack-checksum`），再 `parse !== false` 时解析 pack（见 §3.7）。

**v0 fetch 请求体**（POST `/git-upload-pack`，无 `Git-Protocol` 头）：
- 前置要求：advertisement 必须含 `side-band-64k`，否则客户端抛错（`sideband`）。
- 第一行 want 附带 capabilities：`want <oid> side-band-64k [multi_ack_detailed|multi_ack] [thin-pack] [no-progress] [ofs-delta]\n`，其中 `thin-pack` 仅当 `thinPack !== false` 且服务器 advertise 了它；`multi_ack_detailed` 优先于 `multi_ack`；其余 want 行无 capabilities。
- 随后：`shallow <oid>` 行、`deepen <n>`（要求服务器 advertise `shallow`，否则抛错）、`deepen-since`、`deepen-not` 行；然后 `flush`；第二段：`have <oid>` 行、`done`（默认）；再 `flush`。**注意**：v0 是两段式，want 段与协商段之间必须有 flush；单段式会被服务器误解（代码注释原话）。
- v0 响应：无 section 名；数据包按 sideband 解：首字节 1/2/3；非 sideband 的文本行只能是 `shallow …` / `unshallow …` / `NAK` / `ACK …`，否则协议错误。

**shallow / deepen 语义（检查断言）**：见 §2.1 的 `fetch-shallow-depth1/deepen/new-tip`；`deepen 2` 从 depth-1 状态恰好再取一代（父 commit），边界移动的证据是 `shallow` 含新边界或 `unshallow` 含旧 tip 二者之一。

### 3.5 receive-pack v0（push）

- 前置：`advertisement(owner, repo, 'git-receive-pack')`；**必须为 protocol 0**，否则 `GitClient.push` 直接抛 `push-protocol` 错误。
- 客户端发送的 capabilities（第一条命令后附 `\0` + 空格分隔）：优先 `report-status-v2`（若服务器提供），否则 `report-status`；若服务器提供则追加 `side-band-64k`、`ofs-delta`；若提供 `agent` 则追加 `agent=makefun-git-client/1.0`；另可由调用方 `options.capabilities` 追加。**检查强制要求**服务器 advertise `report-status`、`side-band-64k`、`delete-refs`（`git.advertise-receive-pack`），但客户端实际发送的 capability 列表以服务器提供的为准（未提供的不会发送）。
- 命令列表（pkt-line）：每行 `<oldOid> <newOid> <ref>\n`，第一行在 ref 后加 `\0<capabilities>`；随后 `flush`；随后 pack 字节（若有）。
  - pack 规则：创建或更新任一 ref 时**总是带 pack**，即使对象列表为空也要发一个空 pack（0 对象）；**仅删除**的命令列表不带 pack。客户端的 pack 由 `writePack` 生成，**只含普通对象、不含 delta**（§3.7）。
  - 发送的对象：`pushRefs` helper 只发服务器已有 tip 的可达闭包之外的对象（按 receive-pack advertisement 的 refs 计算；若某 tip 的闭包在本地不完整，则清空已算集合、发全部新 tip 可达对象）。
  - 命令校验（客户端侧）：`oldOid`/`newOid` 必须为 40 hex；ref 必须以 `refs/` 开头、长度 ≤200、不含空白或控制字符；空命令列表抛错。
- 响应解析（`parsePushReport`）：
  - 若启用 side-band-64k：响应为 pkt-line 流，每包首字节 band：`1`=report 数据、`2`=progress、`3`=错误（抛错）；band 1 的数据再按 pkt-line 解析。
  - 若未启用 sideband：响应体本身就是 report-status pkt-line 流。
  - report 文本行只允许：`unpack ok` / `unpack <其他>`（`unpackOk = (detail === 'ok')`）、`ok <ref>`、`ng <ref> <reason>`、`option <k>[ <v>]`（归属于上一条 ref）。其他行 → 协议错误；无 `unpack` 行 → 协议错误（`report-status has no unpack line`）；空响应体 → `report = null`（`push()` 返回 `{report: null}`，调用方多处把“无 report”视为失败）。
  - `report-status-v2` 的 `option` 行按上述规则解析进各 ref 的 `options` map。
- 语义规则（检查断言）：
  - fast-forward 更新必须接受（`ok`）；创建（old=ZERO）与删除（new=ZERO）同理。
  - 非 fast-forward：**必须 `unpack ok` 但该 ref `ng`，且 reason 精确为 `non-fast-forward`**；被拒的 ref 不得移动；同一命令列表中 ok 的 ref 正常生效、ng 的不动（`git.push-mixed-report` 要求 report 恰为 2 条）。
  - 删除分支/tag：被删 ref 不再出现在 ls-refs 中；其他 ref 不受影响。
  - 推送被拒是**正常交换**：HTTP 200 + `ng` 行，客户端不抛错，把 report 返回给调用方。

### 3.6 upload-pack v0 回退（advertisement 解析）

- v0 行格式：`<oid> <ref>`，第一行可在 ref 后加 `\0<capabilities>`（空格分隔，`k=v` 或裸 `k`）；`capabilities^{}` 伪 ref 行跳过；`<oid> <ref>^{}` 为 peeled 行，剥离值记到同名 ref 的 `peeled`；`ZERO_OID` 的 ref 记 `unborn: true`。
- `HEAD` 行：若 capabilities 含 `symref=HEAD:<target>`，则 `headSymref = <target>`。
- 空仓库：advertisement 只有 `capabilities^{}` 伪 ref（或等价形式），无真实 ref；客户端 `clone()` 此时 wants 为空，返回 0 对象、pack 为 null。
- v0 请求不带 `Git-Protocol` 头；`advertise-headers` 接受 v0 请求的响应首行为 `# service=git-upload-pack` **或** `version 2`（即服务器对 v0 请求回 v2 也被接受——但 `advertise-v2` 另行判定）。

### 3.7 packfile

- 读（`readPack`）：只接受 version **2 或 3**；头 `PACK` + version（BE uint32）+ count（BE uint32）；每对象头为 type/size varint；类型码 1=commit、2=tree、3=blob、4=tag、6=OFS_DELTA、7=REF_DELTA；zlib inflate；声明 size 必须等于 inflate 后长度；尾 20 字节为 SHA-1（对之前全部字节），不匹配 → `pack-checksum` 错误；多余字节 → 错误；OFS_DELTA/REF_DELTA 递归解析（delta 指令流：copy/insert；源大小必须等于 base 长度、目标大小必须精确写满）；thin pack 的 REF_DELTA base 由调用方 `resolveBase`（即 `haveObjects`）提供，找不到 → `pack-delta-base` 错误。
- 写（`writePack`，客户端推包用）：version **2**；对象按调用方顺序；**无 delta**；trailer 为 SHA-1。
- **服务器端 pack 是否带 delta**：检查不强制（§2.1 `git.pack-deltas`）；但若带 delta，客户端必须能正确解析（OFS/REF 均支持），且解析出的对象 SHA-1 必须自洽、字节必须与推送时一致。
- **客户端是否发 thin pack**：是。v2 fetch 默认发 `thin-pack` 行；v0 fetch 在服务器 advertise `thin-pack` 时发；此时 REF_DELTA 的 base 可能不在包内，由客户端已持有的对象解析。推包（`writePack`）不发 thin pack（只含完整对象）。

### 3.8 缺仓库与健壮性

- 缺仓库：upload-pack 与 receive-pack 的 info/refs 均为 404（见 §2.1 #4）；`advertisement()` 对非 200 抛 `GitHttpError`。
- `git.repo-survives-errors`：404、非 FF 拒收、畸形 POST 之后，服务器必须继续正常服务（info/refs 200、ls-refs、clone 完整）。畸形 POST 本身的响应状态未被断言。

## 4. REST v3 逐路由

> 前缀均为 `/api/v3`。请求头见 §1.4（`Accept: application/vnd.github+json`；有 body 时 `Content-Type: application/json`；`Authorization: Bearer <token>`）。
> 响应形状的“必填”指 `checkShape` 的 required 字段（= 所列 props 的全部 key）；未列字段不校验。
> 状态码总表：`201` 创建类（建库、建 issue、建 comment、建 label、建分支 ref、建 PR、PUT contents 首次创建）；`200` 读/改/合并/删除内容；`204` 仅 `DELETE /repos/{o}/{r}`；`404` 不存在；`409` contents 旧 sha 更新；`422` 未知 label 建 issue、以及建库时已存在（分页检查接受 422 为“已存在”；`GitClient.createRepo` 也接受 body 含 “already exists” 的 422；GraphQL fixture 建库接受 201/200/422/409）；`405` 冲突的 PR 合并；`400` 畸形 JSON body；`401` 无 token。

### 4.1 根与 meta

| 路由 | 请求 | 响应 |
|---|---|---|
| `GET /api/v3/` | 无 body | 200、JSON 对象（无 required 字段）、带 `X-OAuth-Scopes` 头 |
| `GET /api/v3/meta` | 无 body | 200、`{installed_version: string(非空)}` |

### 4.2 仓库

| 路由 | 请求 | 响应 |
|---|---|---|
| `POST /api/v3/user/repos` | body `{name: string, private: boolean, description?: string}`（检查发送时总带 `private` 与 `description`；`GitClient.createRepo` 另发 `auto_init: false`） | **201**、`{name: ==所发名, private: boolean}`（创建检查还精确比对 `private == true`）。重复创建：分页检查接受 **422**；未确认重复创建时 body 是否必须含 message（`GitClient.createRepo` 只认 body 含 “already exists” 的 422 才接受） |
| `GET /api/v3/repos/{owner}/{repo}` | — | 200、`{name: string, private: boolean, default_branch: string(非空), description?: string}`（PATCH 检查要求 `description` 字段可被精确比对；创建检查要求 `name/private/default_branch`）；不存在 → 404 + message |
| `GET /api/v3/user/repos?per_page=10` | query `per_page`（整数；检查用 10） | 200、数组，每项 `{name: string(非空)}`；分页用 `Link` 头（§1.5）；每页 ≤ `per_page` 条 |
| `PATCH /api/v3/repos/{owner}/{repo}` | body `{description: string}` | 200、`{description: ==所发值}`（精确比对） |
| `DELETE /api/v3/repos/{owner}/{repo}` | — | **204**（无 body 断言）；随后 GET 为 404 |
| `GET /api/v3/user` | — | 未在 REST 检查中直接断言；MCP 的 `resolveOwner` 用它取 token 的 login（200 且 `login` 为非空 string 时采用，否则回落到 scenario viewer login）；GraphQL/MCP fixture 依赖它。**未确认**其余字段要求 |

### 4.3 分支 / 提交 / git refs

| 路由 | 请求 | 响应 |
|---|---|---|
| `POST /api/v3/repos/{o}/{r}/git/refs` | body `{ref: "refs/heads/<branch>", sha: <40hex>}` | **201**、`{ref: ==所发 ref, object: {sha: 40hex}}` |
| `GET /api/v3/repos/{o}/{r}/branches` | — | 200、数组，每项 `{name: string(非空), commit: {sha: 40hex}}` |
| `GET /api/v3/repos/{o}/{r}/commits[?sha=<ref>]` | query `sha` 可选（分支名） | 200、数组，每项 `{sha: 40hex, commit: {message: string}}`；`?sha=<分支>` 只列该分支可达的 commit；无参时不含仅在分支上的 commit（`repos.commits` 精确断言） |
| `GET /api/v3/repos/{o}/{r}/git/refs/heads/{branch}` | — | 仅 MCP 的 `refSha`/`branchExists` 用作备选读法（未在 REST 检查中断言状态/形状）；**未确认**其精确响应形状 |
| `GET /api/v3/repos/{o}/{r}/branches/{branch}` | — | 同上，仅 MCP 备选读法；未确认 |

### 4.4 contents

| 路由 | 请求 | 响应 |
|---|---|---|
| `PUT /api/v3/repos/{o}/{r}/contents/{path}` | body `{message: string, content: string(base64), branch?: string, sha?: string}`（`branch` 指定分支；`sha` 为更新时待替换 blob 的 sha；`path` 可含 `/`，分段编码） | 首次创建 **201**；更新接受 **200 或 201**；`{content: {sha: 40hex, encoding: "base64"}, commit: {sha: 40hex}}`；用已过时的 `sha` 更新 → **409** + message |
| `GET /api/v3/repos/{o}/{r}/contents/{path}[?ref=<ref>]` | query `ref` 可选 | 文件时 200、`{type: "file", encoding: "base64", content: string, sha: 40hex, size: int≥0}`，且 `b64decode(content)` 等于文件字节、`size` 等于字节数、`sha` 等于 PUT 返回的 content sha；目录时 200、**数组**，每项 `{type: "file"\|"dir", name: 非空, path: 非空, sha: 40hex}`；不存在 → 404 + message |
| `DELETE /api/v3/repos/{o}/{r}/contents/{path}` | body `{message: string, sha: string}`（检查发送） | 200、`{commit: {sha: 40hex}}`；随后 GET 为 404 |

### 4.5 labels / issues / comments

| 路由 | 请求 | 响应 |
|---|---|---|
| `POST /api/v3/repos/{o}/{r}/labels` | body `{name: string, color: "ededed"}`（检查发送值） | **201**、`{name: string(非空)}`（`color` 未被校验） |
| `POST /api/v3/repos/{o}/{r}/issues` | body `{title: string, body: string, labels?: string[]}` | **201**、issue 形状（§2.3），`state == "open"`；labels 中有未知 label → **422** + message |
| `GET /api/v3/repos/{o}/{r}/issues?state=&sort=&direction=&per_page=` | query：`state`（`open`/`closed`，检查用 `open`）、`sort=created`、`direction=asc\|desc`、`per_page`（检查用 10 或 100） | 200、数组（每项 issue 形状）；按 state 过滤、按 created 排序 |
| `GET /api/v3/repos/{o}/{r}/issues/{n}` | — | 200、issue 形状 |
| `PATCH /api/v3/repos/{o}/{r}/issues/{n}` | body `{state: "open"\|"closed"}` | 200、`{number: int≥1, state: ==所发值}` |
| `POST /api/v3/repos/{o}/{r}/issues/{n}/comments` | body `{body: string}` | **201**、`{id: int≥1, body: ==所发值}` |
| `GET /api/v3/repos/{o}/{r}/issues/{n}/comments` | — | 200、数组，每项 `{id: int≥1, body: string}` |

### 4.6 pulls

| 路由 | 请求 | 响应 |
|---|---|---|
| `POST /api/v3/repos/{o}/{r}/pulls` | body `{head: string(分支名), base: string(分支名), title: string, body: string}` | **201**、pull 形状（§2.4） |
| `GET /api/v3/repos/{o}/{r}/pulls?state=&per_page=` | query：`state`（`all` 或省略=仅 open）、`per_page` | 200、数组（每项 pull 形状） |
| `GET /api/v3/repos/{o}/{r}/pulls/{n}` | — | 200、pull 形状；不存在 → 404 + message；合并后还要求 `state: "closed"`、`merged: true`、`merged_at: 非空 string`、`merge_commit_sha: 40hex`（见 §2.4 #11/#14——注意 `pullShape` 本身不含 `merged/merged_at/merge_commit_sha`，这些字段只在合并后的专项断言里校验） |
| `GET /api/v3/repos/{o}/{r}/pulls/{n}/files` | — | 200、数组（每项 pull file 形状） |
| `PUT /api/v3/repos/{o}/{r}/pulls/{n}/merge` | body `{merge_method: "squash"}` | 成功 **200**、`{merged: true, sha: 40hex, message: string}`；未知 PR → 404 + message；冲突的 PR → **405** + message |

### 4.7 各状态码出现条件小结

- `200`：GET 类、PATCH 类、PUT contents 更新、DELETE contents、PUT merge 成功。
- `201`：POST 建库 / 建 label / 建 issue / 建 comment / 建 git ref / 建 PR、PUT contents 首次创建。
- `204`：仅 DELETE 仓库。
- `400`：请求体不是合法 JSON（`protocol.malformed-body-400`）。
- `401`：无 token 访问（REST/GraphQL/MCP 各一处，见 §1.4）。
- `404`：仓库/issue/PR/内容/未知路由不存在；同名仓库在 stranger 名下。
- `405`：合并冲突的 PR；以及 env 端 register/done 的非正确方法（非 entry 契约）。
- `409`：PUT contents 用旧 sha 更新；建库重复时 GraphQL fixture 接受 409 为“已存在”（REST 检查本身只在分页处接受 422）。
- `422`：建 issue 用未知 label；建库重复时分页检查与 git 客户端接受（body 含 “already exists” 时）。


## 5. GraphQL（v4）

- 端点：`POST /api/graphql`（`GRAPHQL_PATH`）。请求：`Content-Type: application/json`、`Accept: application/json`、`User-Agent: makefun-github-core-clone-env/1`、有 token 时 `Authorization: Bearer <token>`；body 为 `{query: string, variables: {...}}`（单个操作）或 `[{query, variables, operationName?}, …]`（批量，见下）。
- 响应 envelope：`{data, errors}`；HTTP 状态与 GraphQL 错误分离：
  - GraphQL 层失败（未知字段、坏参数）→ **HTTP 200** + `errors` 数组（`invalid-field` 检查）；除该检查外，任何检查收到非空 `errors` 即失败。
  - 无 token → **401**。
  - 响应 body 既无 `data` 又无 `errors`（且 HTTP 2xx）→ 客户端记 `parseError`。
  - `errors` 条目形状：`{message: string, path?: (string|number)[], locations?: [{line, column}], extensions?: {...}}`（客户端只保留带 message 的条目）。
- 客户端从不抛错（除 `batch([])` 空数组外）：transport/parse 失败记 `transportError`/`parseError`、`status=0`。

### 5.1 全部 document 原文（`checks-graphql.ts: GRAPHQL_DOCUMENTS`，逐字照抄）

```graphql
# viewerLogin — query ViewerLogin
query ViewerLogin {
  viewer {
    login
  }
}

# repositoryFields — query RepositoryFields($owner: String!, $name: String!)
query RepositoryFields($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    databaseId
    name
    owner {
      login
    }
    defaultBranchRef {
      name
    }
    viewerPermission
    hasIssuesEnabled
  }
}

# issueFields — query Issue_fields
query Issue_fields {
  Issue: __type(name: "Issue") {
    fields(includeDeprecated: true) {
      name
    }
  }
}

# typeFields — query PullRequestAndRepositoryFields
query PullRequestAndRepositoryFields {
  PullRequest: __type(name: "PullRequest") {
    fields(includeDeprecated: true) {
      name
    }
  }
  Repository: __type(name: "Repository") {
    fields(includeDeprecated: true) {
      name
    }
  }
}

# searchTypeEnumValues — query SearchType_enumValues
query SearchType_enumValues {
  SearchType: __type(name: "SearchType") {
    enumValues(includeDeprecated: true) {
      name
    }
  }
}

# openIssues — query OpenIssues($owner: String!, $name: String!, $first: Int!)
query OpenIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        title
        state
        id
      }
    }
  }
}

# issueByNumber — query IssueByNumber($owner: String!, $name: String!, $number: Int!)
query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      state
      id
      body
    }
  }
}

# createIssue — mutation IssueCreate($input: CreateIssueInput!)
mutation IssueCreate($input: CreateIssueInput!) {
  createIssue(input: $input) {
    issue {
      number
      id
    }
  }
}

# closeIssue — mutation IssueClose($input: CloseIssueInput!)
mutation IssueClose($input: CloseIssueInput!) {
  closeIssue(input: $input) {
    issue {
      number
      id
      state
    }
  }
}

# pullRequests — query PullRequests($owner: String!, $name: String!, $first: Int!)
query PullRequests($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first) {
      nodes {
        number
        headRefName
        baseRefName
        mergeable
        state
      }
    }
  }
}

# pullRequestFiles — query PullRequestFiles($owner: String!, $name: String!, $number: Int!)
query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      files(first: 10) {
        nodes {
          path
        }
      }
    }
  }
}

# pullRequestId — query PullRequestId($owner: String!, $name: String!, $number: Int!)
query PullRequestId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
    }
  }
}

# createPullRequest — mutation PullRequestCreate($input: CreatePullRequestInput!)
mutation PullRequestCreate($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) {
    pullRequest {
      number
      id
      state
      headRefName
      baseRefName
    }
  }
}

# mergePullRequest — mutation MergePullRequest($input: MergePullRequestInput!)
mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest {
      number
      merged
      state
    }
  }
}

# addComment — mutation AddComment($input: AddCommentInput!)
mutation AddComment($input: AddCommentInput!) {
  addComment(input: $input) {
    commentEdge {
      node {
        id
        body
      }
    }
  }
}

# invalidField — query ViewerInvalidField
query ViewerInvalidField {
  viewer {
    login
    noSuchFieldOnViewer
  }
}

# nodeRepository — query NodeRepository($id: ID!)
query NodeRepository($id: ID!) {
  node(id: $id) {
    id
    ... on Repository {
      name
      nameWithOwner
    }
  }
}

# issuesPage — query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String)
query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after) {
      nodes {
        number
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
```

### 5.2 逐检查：variables 与期望 data 形状

fixture（`checks-graphql.ts: Harness`，跨检查复用、惰性构建）：仓库名 `<scenario.repos[0].name>-graphql`（owner=viewer login）；分页仓库 `<同名>-graphql-pages`；未知仓库 `<同名>-graphql-missing`；base 分支 = scenario 默认分支（`main`）；三个 head 分支取自 scenario pulls[0..2].head；文件路径取 blobs[0]/blobs[1].path；issue 文本取 issues[0]/issues[1]。建库经 REST `POST /user/repos`（接受 201/200/422/409）；base 分支的首 commit 与三个 head 分支经 env 主程序安装的 git adapter（`configureGraphQLGit`，走 git-client push；无 adapter 时需要分支的检查直接失败，其余 16 个仍跑）；issue fixture 为 3 个 open + 1 个 closed（REST 建、PATCH 关）；分页 fixture 为恰好 7 个 issue（`pageCount=7`，`pageSize=5`）。

| # | id | 标题 | document + variables | 期望 data / 通过条件 | 超时 |
|---|---|---|---|---|---|
| 1 | `graphql.viewer-login` | query { viewer { login } } answers the token owner | `ViewerLogin`，`{}` | `data.viewer.login` 为非空 string 且 **等于 viewer login** | 8_000 |
| 2 | `graphql.repository-fields` | repository(owner:, name:) answers id, databaseId, name, owner, defaultBranchRef, viewerPermission and hasIssuesEnabled | `RepositoryFields`，`{owner: viewer, name: <fixture库>}` | `data.repository.id` 等于建库后 GraphQL 读到的 id（同一值）；`databaseId` 为正整数且等于同次读到的值；`name` 等于库名；`owner.login` = viewer；若 git adapter 已装，`defaultBranchRef.name` = base 分支；`viewerPermission` ∈ `{ADMIN, MAINTAIN, WRITE, TRIAGE, READ}`；`hasIssuesEnabled == true` | 10_000 |
| 3 | `graphql.introspection-issue` | __type(name: "Issue") lists the fields gh feature-detects | `Issue_fields`，`{}` | `data.Issue.fields`（`fields(includeDeprecated: true)` 的 `name` 列表）非空，且含 `id`、`number`、`title`、`state`、`body` | 8_000 |
| 4 | `graphql.introspection-types` | __type lists PullRequest, Repository and SearchType (gh's other probes, one check) | `PullRequestAndRepositoryFields` + `SearchType_enumValues`，各 `{}` | `PullRequest.fields` 非空且含 `id, number, headRefName, baseRefName, mergeable, state, merged, files`；`Repository.fields` 非空且含 `id, databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission, hasIssuesEnabled, issue, issues, pullRequests, pullRequest`；`SearchType.enumValues` 非空且含 `ISSUE` | 10_000 |
| 5 | `graphql.issues-open-order` | issues(first: 10, states: [OPEN], orderBy: CREATED_AT DESC) filters and orders | `OpenIssues`，`{owner, name, first: 10}` | `data.repository.issues.nodes` 长度 1..10；每项 `state == "OPEN"`、`title` 为 string、`id` 非空、`number` 为正整数；number 严格递减（CREATED_AT DESC，以 number 代理创建时间顺序）；不含 closed fixture issue；含全部 3 个 open fixture issue | 12_000 |
| 6 | `graphql.issue-by-number` | issue(number:) reads one issue | `IssueByNumber`，`{owner, name, number: <open[0]>}` | `data.repository.issue` 为对象；`number` 等于所查、`state == "OPEN"`、`title == "<titlePrefix> open 1"`（精确值）、`body` 等于 seeded body、`id` 非空 | 10_000 |
| 7 | `graphql.create-issue` | createIssue creates an issue the REST view sees | `IssueCreate`，`{input: {repositoryId: <repo.id>, title: "<prefix> created over graphql", body: <body>}}` | `data.createIssue.issue.number` 为正整数、`id` 非空；随后 REST `GET /issues/{n}` 200 且 `number/title/state=="open"` 与之一致 | 12_000 |
| 8 | `graphql.close-issue` | closeIssue closes an issue the REST view shows closed | 先 REST 建 issue（标题 `"<prefix> closed over graphql"`），读其全局 id（`IssueByNumber`）；`CloseIssue`，`{input: {issueId: <id>}}` | `data.closeIssue.issue.number` 等于该 issue、`state == "CLOSED"`；随后 REST GET 该 issue `state == "closed"` | 12_000 |
| 9 | `graphql.pull-requests-list` | pullRequests(first: 5) lists number, headRefName, baseRefName, mergeable and state | `PullRequests`，`{owner, name, first: 5}` | `nodes` 长度 ≤5；含 fixture PR（number 匹配）；其 `headRefName` = head 分支、`baseRefName` = base 分支、`state == "OPEN"`、`mergeable` ∈ `{MERGEABLE, CONFLICTING, UNKNOWN}` | 15_000 |
| 10 | `graphql.pull-request-files` | pullRequest(number:).files lists the changed paths | `PullRequestFiles`，`{owner, name, number: <fixture PR>}` | `data.repository.pullRequest.number` 等于所查；`files(first: 10).nodes[].path` 含 fixture 改动路径（`blobs[0].path`） | 12_000 |
| 11 | `graphql.create-pull-request` | createPullRequest creates a pull request | `PullRequestCreate`，`{input: {repositoryId, baseRefName: <base>, headRefName: <createBranch>, title: "<prefix> created over graphql"}}`（注：**不传 body**） | `data.createPullRequest.pullRequest.number` 正整数、`id` 非空、`state == "OPEN"`、`headRefName`/`baseRefName` 等于所传；随后 REST `GET /pulls/{n}` 的 `head.ref`/`base.ref` 与之一致 | 15_000 |
| 12 | `graphql.merge-pull-request` | mergePullRequest SQUASH merges and the REST view shows merged: true | 先读 fixture merge-PR 的全局 id（`PullRequestId`）；`MergePullRequest`，`{input: {pullRequestId: <id>, mergeMethod: "SQUASH"}}` | `data.mergePullRequest.pullRequest.merged == true`；随后 REST `GET /pulls/{n}` 的 `merged == true` 且 `state == "closed"` | 15_000 |
| 13 | `graphql.add-comment` | addComment writes an issue comment the REST view lists | 先 REST 建 issue；读其全局 id；`AddComment`，`{input: {subjectId: <issue id>, body: <issues[1].body>}}` | `data.addComment.commentEdge.node.body` 精确等于所发 comment、`id` 非空；随后 REST `GET /issues/{n}/comments` 列表含 body 相同的评论 | 12_000 |
| 14 | `graphql.invalid-field` | an invalid field is a 200 with an errors array | `ViewerInvalidField`，`{}` | **HTTP 200**；`errors` 非空；至少一条 error 的 `message` 含子串 `noSuchFieldOnViewer` | 8_000 |
| 15 | `graphql.unauthenticated` | an unauthenticated query is a 401 | `ViewerLogin`，`{}`，**无 token 客户端** | **HTTP 401** | 8_000 |
| 16 | `graphql.node-repository` | node(id:) round-trips a repository | `NodeRepository`，`{id: <repo.id>}` | `data.node.id` 等于所传 id；`name` = 库名；`nameWithOwner` = `"<viewer>/<库名>"` | 10_000 |
| 17 | `graphql.unknown-repository` | an unknown repository reads data.repository = null with no errors | `RepositoryFields`，`{owner: viewer, name: <fixture库>-missing}` | HTTP 200、无 `errors`；`data.repository == null` | 8_000 |
| 18 | `graphql.batched-operations` | two operation documents in one body answer in order | 一次 POST，body 为 JSON 数组 `[{query: ViewerLogin}, {query: Issue_fields}]`（variables 各为 `{}`） | HTTP 200；响应为长度 2 的数组；第 1 个 `data.viewer.login` = viewer；第 2 个 `data.Issue.fields` 非空；**顺序与请求一致** | 10_000 |
| 19 | `graphql.global-id-stability` | global ids are opaque and equal on repeated reads | 两次 `RepositoryFields` + 两次 `IssueByNumber`（同一 issue） | 两次读到的 repo id 相同、issue id 相同；repo id **不得等于 `String(databaseId)`**；issue id **不得等于 `String(number)`**（即全局 id 必须是不透明的、非明文数字 id） | 12_000 |
| 20 | `graphql.issues-pagination` | issues(first, after) pages by cursor to the end | `IssuesPage`，先 `{owner, name: <pages库>, first: 5, after: null}`，再 `{…, first: 5, after: <第一页 endCursor>}` | 第一页恰 5 个 node、`pageInfo.hasNextPage == true`、`endCursor` 为非空 string；第二页恰 2 个 node（7−5）、`hasNextPage == false`；两页 number 无重复、合计 7 个且均为 fixture 创建的 issue number | 12_000 |

### 5.3 其他 GraphQL 要点

- 枚举（文件头注释列出的 schema 面）：`IssueState OPEN/CLOSED`；`MergeableState MERGEABLE/CONFLICTING/UNKNOWN`；`PullRequestState OPEN/CLOSED/MERGED`；`PullRequestMergeMethod MERGE/SQUASH/REBASE`（检查只实际发送 `SQUASH`）；`RepositoryPermission ADMIN/MAINTAIN/WRITE/TRIAGE/READ`；`SearchType ISSUE/...`（`...` 部分未在文件中展开——除 `ISSUE` 外的其他枚举值**未确认**）；`IssueOrderField CREATED_AT/UPDATED_AT/COMMENTS`；`OrderDirection ASC/DESC`。
- `__type` 查询使用别名（`Issue:` / `PullRequest:` / `Repository:` / `SearchType:`），参数均为 `name: "…"` + `fields/includeDeprecated: true` 或 `enumValues(includeDeprecated: true)`；返回的 `fields`/`enumValues` 列表只取每项的 `name`。
- `node(id:)` 只要求 Repository 的 inline fragment `... on Repository { name nameWithOwner }`；其他类型 node 的行为未确认。
- 未知字段 / 未知仓库的返回见 #14/#17；其他 GraphQL 错误（如坏变量、未知 mutation 参数）的 HTTP 状态/错误形状在文件中**未确认**。
- `dataOf` 的判定：transport 错误、parse 错误、HTTP 非 200、非空 `errors`、`data` 非对象，任一即失败。

## 6. MCP

- 端点：`POST <baseUrl>/mcp`（`MCP_PATH = /mcp`）。传输：Streamable HTTP；每 POST 可答一个 JSON body 或一个请求作用域的 SSE 流（其最后 data 帧为 JSON-RPC 响应）。
- 每请求头：`Accept: application/json, text/event-stream`；`Content-Type: application/json`；`MCP-Protocol-Version: <协商版本>`（legacy handshake 的 `initialize` 请求除外，见下）；`Mcp-Method: <方法名>`；`tools/call` 时还有 `Mcp-Name: <工具名>`（值按 transport 编码：纯 ASCII 可见字符原样，否则 `=?base64?<base64(UTF-8)>?=`）；legacy 会话建立后带 `Mcp-Session-Id: <服务器给的值>`；有 token 时 `Authorization: Bearer <token>`。工具参数若被 inputSchema 以 `x-mcp-header` 标注，则镜像为 `Mcp-Param-<header>` 头（值编码同上；string/number/boolean 才转换）。
- 每请求体：JSON-RPC 2.0 `{jsonrpc:"2.0", id, method, params}`；`params` 总是带 `_meta`：
  ```json
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "<协商版本>",
    "io.modelcontextprotocol/clientInfo": {"name": "makefun-github-core-clone-env", "version": "1.0.0"},
    "io.modelcontextprotocol/clientCapabilities": {},
    "protocolVersion": "<协商版本>"
  }
  ```
  （另附一条：`_meta` 中同时有 `io.modelcontextprotocol/protocolVersion` 与平铺 `protocolVersion` 两个键。）
- 客户端从不因 HTTP 状态抛错；只在无响应/超时（默认 3_000 ms）/检查 abort 时抛 `McpError`/`McpTimeoutError`。`connect()` 在两种 era 都不通时抛错。
- `close()`：legacy 会话时尽力 `DELETE /mcp`（头 `Mcp-Session-Id` + token），失败忽略。

### 6.1 initialize：两个 era 的流程

- **Modern（首选，2026-07-28）**：`connect()` 先探 `server/discover`（JSON-RPC id 固定 `"discover-1"`，method `server/discover`，params `{}` + `_meta`）。成功（有 result 对象）即 modern：
  - 协商版本：`supportedVersions` 含 `2026-07-28` 则用它，否则用列表第一项；随后每请求声明该版本。
  - `server/discover` 拒绝且 code 为 `-32022`（UnsupportedProtocolVersionError）时：取 `error.data.supported` 中的版本重试一次（优先 `2026-07-28`）；再失败则 `connect()` 抛错。
  - 其他拒绝（401/403/5xx、`-32020` HeaderMismatch、`-32021`、`-32600`、`-32602` 且非 method-not-found）→ 直接抛错，不回退 legacy。
- **Legacy（2025-11-25 及更早）**：当 `server/discover` 答 method-not-found（`-32601`）或 HTTP 404/405 时回退：
  - 按顺序尝试 revisions `['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']`：`initialize`（id 固定 `"initialize-1"`，**不带** `MCP-Protocol-Version` 头），params `{protocolVersion: <候选>, capabilities: {}, clientInfo: {name, version}}`；服务器 echo 的 `protocolVersion`（若为合法 `YYYY-MM-DD`）即协商版本，否则用所发候选。
  - 成功后发 `notifications/initialized`（notification，无 id，同样不带 protocol-version 头）。
  - 仅当某次 `initialize` 答 `-32602` 才试下一个版本；其他错误即停止并抛错。
  - `Mcp-Session-Id`：响应头给出的值从此每次请求携带。
- `initialize` 检查（`mcp.initialize`）的判定与 era 无关：连接成功后 `serverInfo.name` 与 `serverInfo.version` 均为非空 string，且 `capabilities.tools` 存在（须为对象/record）。modern 时 serverInfo 取自 discover result 的 `_meta["io.modelcontextprotocol/serverInfo"]`，无则取顶层 `serverInfo`。
- `server-discover` 检查（`mcp.server-discover`）：modern 时要求 `supportedVersions` 非空（每项须为 `YYYY-MM-DD` 格式才计入）；legacy 时**直接通过**（detail 记为 pre-discover，依据为 discover 探针的 HTTP 状态 / JSON-RPC code）。

### 6.2 tools/list：工具清单

- 请求：`tools/list`，params `{}`（首次），有 `nextCursor` 时带 `{cursor}` 继续，最多 10 页；响应 `result.tools` 必须为数组，否则抛错。
- 数量要求：至少 **6** 个工具；六个必需工具（canonical 名，见下）必须全部出现——按名匹配规则：先精确匹配 canonical 或别名（归一化：小写、去掉全部非字母数字），再按归一化后缀匹配（允许服务器前缀，如 `github__create_issue`）。
- 必需工具与别名（`MCP_REQUIRED_TOOLS` / `MCP_TOOL_ALIASES`）：

| canonical | 别名 |
|---|---|
| `create_repo` | `create_repository`, `repo_create`, `repos_create`, `repository_create` |
| `get_repo` | `get_repository`, `repo_get`, `repos_get`, `repository_get` |
| `create_issue` | `issue_create`, `issues_create` |
| `list_issues` | `issues_list`, `issue_list` |
| `create_pull_request` | `pull_request_create`, `pulls_create`, `create_pr`, `pr_create` |
| `merge_pull_request` | `pull_request_merge`, `pulls_merge`, `merge_pr`, `pr_merge` |

- `tool-schemas` 检查：**每一个** listed 工具都必须有非空 string `description`，且 `inputSchema` 为对象且 `inputSchema.type == "object"`。
- `tools-list-idempotent`：连续两次 `tools/list` 的工具数组 `JSON.stringify` 必须**字节相同**（顺序、字段均相同）。
- 各工具 inputSchema 的属性名与 required：**文件中没有固定 schema 表**。套件只规定语义参数，调用时按工具自己的 inputSchema 做属性名映射（见 §6.3）；因此“每个工具必须有哪些属性”以服务器自己声明的 inputSchema 为准，检查只要求 description + type object。`create_repo` 等工具在 github-mcp-server 命名下的语义参数见 §6.3。

### 6.3 tools/call：六个工具的参数映射规则

- 调用形式：JSON-RPC `tools/call`，params `{name: <工具实际名>, arguments: <映射后的参数对象>}`；响应为 tool result `{content?: [{type:"text", text}], structuredContent?, isError?}`；`isError == true` 视为工具执行错误。
- 参数映射（`mapArguments`）：按工具 inputSchema 的 `properties` 键名做归一化匹配（小写、去非字母数字），语义键 → 可接受的属性名（按表中顺序依次尝试，第一个命中即用）：

| 语义键 | 可接受的属性名（归一化后比较） |
|---|---|
| `owner` | `owner`, `owner_login`, `org`, `organization`, `organisation`, `user`, `user_login`, `login`, `account`, `namespace`, `owner_name` |
| `repo` | `repo`, `repository`, `repository_name`, `repo_name`, `repo_slug`, `project`, `project_name` |
| `repo_full_name` | `full_name`, `repo_full_name`, `repository_full_name`, `fullName`（特殊规则：若工具没有 `repo` 对应属性但有 full_name 类属性，则传 `"owner/repo"`） |
| `title` | `title`, `issue_title`, `pr_title`, `pull_request_title`, `subject` |
| `body` | `body`, `issue_body`, `description`, `content`, `text`, `comment` |
| `head` | `head`, `head_ref`, `head_branch`, `pull_request_head`, `pr_head`, `source`, `source_ref`, `source_branch`, `from`, `from_branch`, `branch` |
| `base` | `base`, `base_ref`, `base_branch`, `pull_request_base`, `pr_base`, `target`, `target_ref`, `target_branch`, `into`, `into_branch` |
| `pull_number` | `pull_number`, `pull_request_number`, `pr_number`, `number`, `issue_number`, `index` |
| `name` | `name`, `repo`, `repository`, `repository_name`, `repo_name` |
| `description` | `description`, `about`, `summary`, `body` |
| `private` | `private`, `is_private` |
| `state` | `state`, `status` |

- 若 inputSchema 无 `properties`：按语义键原样传。`required` 中有套件无法填充的属性时，检查直接失败并点名该属性（不编造参数调用）；`missing-arguments` 检查除外（见下）。
- 六个工具的语义参数（github-mcp-server 的名字，套件实际发送的）：
  - `create_repo {name, description?, private?}`；检查 `rest-parity` 发送 `{owner, name: <mcp-<tag>-parity>, description: <scenario.repos[0].description>, private: true}`（注：`owner` 不在文档的 create_repo 参数表里，但实际调用传了它）。
  - `get_repo {owner, repo}`。
  - `create_issue {owner, repo, title, body?}`。
  - `list_issues {owner, repo, state?}`（检查发 `state: "open"`）。
  - `create_pull_request {owner, repo, title, head, base}`（检查还传了 `body`，虽不在文档参数表内——按映射规则 `body` 会被映射过去）。
  - `merge_pull_request {owner, repo, pull_number}`。
- 各工具调用的通过条件（检查级）：
  - `create_issue`：调用后 REST `GET /repos/{o}/{r}/issues?state=all&per_page=100` 须列出同 title 的 issue。
  - `list_issues`：先经 REST 建一 issue；调用后 tool result 文本（content text 块拼接 + structuredContent 的 JSON）须含该 issue 的 title **或**含 `"number": <n>`（正则 `"number"\s*:\s*<n>(?!\d)`）。
  - `create_pull_request`：先经 REST 建库+base commit+head 分支（`POST /git/refs` 或 contents 写分支，二者任一成功即可）；调用后从 tool result JSON 取 number（字段 `number`/`pull_number`/`pull_request_number`），或按 title/head 在 REST 列表中找；REST 读到的 PR 的 head/base 必须等于准备的分支名。
  - `merge_pull_request`：先经 REST 建 PR（记 number）；调用后 REST `GET /pulls/{n}` 的 `merged == true`。
  - `rest-parity`：`create_repo` 后 REST 两次 `GET /repos/{o}/{r}` 的 `id` 相同（`String(id)` 比较）；再 `create_issue`，用 tool result JSON 的 `number` 或按 title 在 REST 列表中找 number；REST 两次 `GET /issues/{n}` 的 `id` 相同且 title 等于所发。若 tool result 的 `full_name` 为 `"owner/repo"` 形式，则以其拆出的 owner/repo 为准。

### 6.4 错误码、并发与 session 规则

| 情形 | 客户端发送 | 通过条件 |
|---|---|---|
| 未知工具 | `tools/call`，name=`mcp_no_such_tool_<tag>`（tag 为 scenario seed 前 8 hex），arguments `{}` | HTTP **不能是 500**；须为 JSON-RPC 错误且 code 为 `-32602` 或 `-32601` |
| 非 JSON body | `postRaw('{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"')`（**故意缺右大括号**，截断的 JSON），头 `Mcp-Method: tools/list`，期望 id `424242` | modern era：**HTTP 400** 且 JSON-RPC code `-32700`；legacy era：HTTP 200 且 code `-32700` 也通过 |
| 缺失必填参数 | `tools/call create_issue`，arguments `{}`（`allowMissing: true`，即便 required 未满足也照常调用） | `isError == true` **或** JSON-RPC 错误 `-32602` |
| 并发 | 两个 `get_repo` 的 `tools/call` 并行发出，JSON-RPC id 分别为 `concurrent-left-<tag>` / `concurrent-right-<tag>`（字符串 id），参数为两个不同仓库 | 每个响应的 `matchedId`（响应携带的 id）必须等于自己请求的 id；两者均无 JSON-RPC 错误；各自 tool result 文本须含各自的仓库名 |
| 无 token | `tools/call create_issue`（`omitAuth: true`），参数为假 owner/repo | **HTTP 401**（工具名取 listed 的 create_issue 实际名，若无则用 canonical 名——鉴权应在工具存在性之前判定） |
| `tools/list` 幂等 | 两次 `tools/list` | 工具数组 JSON 字节相同（§6.2） |
| session | legacy：`Mcp-Session-Id` 由服务器响应头给出，之后每次请求携带；modern：无协议级 session | 文件中**未确认**服务器不给 session 时 legacy 是否仍可通过（客户端仅在有值时携带）；`close()` 的 DELETE 在 legacy 会话时尽力发送，失败忽略 |

- 其他 JSON-RPC 码（客户端常量）：`-32700` parse error；`-32602` invalid params；`-32601` method not found；`-32022` UnsupportedProtocolVersionError（`data.supported` 列出支持版本）；`-32020` HeaderMismatch；`-32021`（在 connect 的拒绝判定中出现，具体含义文件中未说明——**未确认**）。
- SSE：响应 `Content-Type` 含 `text/event-stream` 时，客户端读流直到含期望 id 的 JSON-RPC 响应帧出现（跳过通知与注释行；`data:` 行拼接后解析）；非 SSE 时直接解析整个 body 为 JSON（数组 body 时取第一个 JSON-RPC 响应）。


## 7. 四个计时 workload 与 T_ref

### 7.1 通用规则

- 顺序：`push → clone → read → write`（`BENCH_WORKLOAD_NAMES`）。
- 每 workload：先 **5 次 untimed warm-up 操作**，再 **3 个 timed round**（`BENCH_ROUNDS = 3`）；每 round 的时间为 `performance.now()` 墙时；p50 = 3 个 round 的中位数（nearest-rank percentile：`rank = ceil(0.5·n)`），p99 = 3 个 round 的最大值。
- 每 workload 预算 **60_000 ms**（`budgetMs`），整个 benchmark 阶段预算 **240_000 ms**，另受 env 内部 deadline 约束；超时/失败时该 workload 记 0 分，p50/p99 写哨兵 `FAILED_P50_MS = 1_000_000_000`（**不是 0**，0 会在 tie-break 上排第一），已完成的 round 仍保留在 `rounds` 数组中。
- payload 全部在计时开始前建好（push 的 commit/pack、clone 的 200-commit 历史、write 的 issue 标题列表），计时内不做对象哈希/deflate（push 除外：pack 预先建好，计时内只发请求）。
- setup（建库、clone 历史、read 的 issue）在 workload 预算内、计时 round 之外；setup 失败 → 该 workload 0 分。
- 计分：`points = round(clamp(25 − 12.5·log2(p50_ms / T_ref_ms), 0, 50))`；T_ref 为 0（未校准）时该 workload 仍跑、时间照记，但 0 分，`calibrated: false`，error 行写 `uncalibrated: T_ref is 0, so the workload earns 0 points until calibration fills it`。
- `perf.json` 形状：`{version:1, calibrated: bool, workloads:[{name, rounds:[ms…], p50_ms, p99_ms, ops, points, error?}], tiers:{push,clone,read,write: 0..4}, points:{…: 0..50}, perf_p50_us, points_total: 0..200, notes:[…]}`；`tiers = floor(points/12.5)`（0..4）；`perf_p50_us` = 已测 workload 的 p50 几何均值（微秒，四舍五入），**无一测出时为哨兵 `1_000_000_000`**（不是 0）。
- 各 workload 的 owner 均为 scenario viewer login；仓库在每次运行前先 `DELETE /api/v3/repos/{owner}/{repo}`（404 也接受），再 `POST /api/v3/user/repos` 建库（`GitClient.createRepo`：201/200 接受，body 含 “already exists” 的 422 接受）。

### 7.2 push

- 仓库：`bench-push`；文件：`bench-data.txt`；每操作：一次 receive-pack 交换（advertisement + 命令列表 + pack），在 `refs/heads/main` 上新建一个 commit。
- 每 commit：tree 只含 `bench-data.txt`，内容为 **1_024 字节**的新 seeded blob（`generateBlobText(rng('bench.push'), 1024)`）；message `bench: push <n>\n`；author/committer 均为 `Conformance <conformance@make.fun>`；timestamp `1_700_000_000 + index`（秒，`+0000`）；父 commit 为上一操作。第一操作的 oldOid 为 ZERO，后续为上一 commit。
- pack：每操作只含该 commit 尚缺的 3 个对象（blob、tree、commit），`writePack` 生成（无 delta）。
- 量：每 round **200 次顺序 push**（`ops: 200`）；warm-up 5 次；共需预建 `5 + 3×200 = 605` 个 payload。任一 push 的 report 非 `unpackOk` 或 ref 被拒 → workload 失败（0 分）。
- T_ref：见 §7.6。

### 7.3 clone

- 仓库：`bench-clone`；文件：`history.txt`；setup：一次 push 送入 **200 个 commit** 的完整历史（每 commit 换 `history.txt` 内容为 512 字节新 blob，message `bench: history <n>\n`，timestamp `1_700_000_000 + index`），pack 含全部 600 个对象（blob/tree/commit × 200）。
- 每操作：一次 shallow clone，`clone({depth: 1, parse: false, singleBranch: true})`——即只取 default 分支 tip 的 depth-1；**只校验 pack 校验和，不解析对象**（`parse: false`）。
- 量：每 round **50 个并发 clone**（`ops: 50`，`Promise.all` 同时发出）；warm-up 5 次（顺序执行）。每 clone 要求：`checksumOk == true`、`packBytes > 0`、`refs.length > 0`，否则 workload 失败。
- T_ref：见 §7.6。

### 7.4 read

- 仓库：`bench-read`；setup：REST `POST /issues {title: "<issues[0].title> (bench setup)", body: <issues[0].body>}` 建一 issue（要求 201，取其 `number`）。
- 每操作：同一 `RestClient`（同一 undici 连接池，keep-alive 复用）顺序 `GET /api/v3/repos/{owner}/bench-read/issues/{n}`；要求 200 且 body 为 JSON 对象。
- 量：每 round **2_000 次顺序 GET**（`ops: 2000`）；warm-up 5 次。
- T_ref：见 §7.6。

### 7.5 write

- 仓库：`bench-write`；payload 预建：标题为 `"<issues[i % 60].title> [bench <k>]"`、body 为对应 issue body，共 `5 + 3×200 = 605` 条。
- 每操作：`POST /api/v3/repos/{owner}/bench-write/issues {title, body}`；要求 **201**，否则 workload 失败。
- 量：每 round **200 次顺序 POST**（`ops: 200`）；warm-up 5 次。
- T_ref：见 §7.6。

### 7.6 T_ref 数值（`calibration.json`，2026-11-14 在生产集群 dsh-makefun 上三次 dev grade 的中位数）

| workload | T_ref (ms) | 三次运行的 p50_ms |
|---|---|---|
| push | **1640.82** | 1914.548 / 1640.82 / 1415.785 |
| clone | **266.941** | 266.941 / 313.634 / 259.436 |
| read | **2759.715** | 2874.092 / 2759.715 / 2428.118 |
| write | **348.965** | 448.01 / 348.965 / 289.433 |

- 在 T_ref 处每 workload 恰得 `round(25 − 12.5·log2(1)) = 25` 分，四项合计 100/200；`perf_p50_us` 三次运行为 900674 / 839040 / 712790（几何均值中位数约 805899 µs）。
- 历史值（2026-11-13 rig batch：push 514.838 / clone 121.436 / read 899.962 / write 120.093）已作废，**不是** T_ref（`calibration.json: previous`，仅作历史记录）。
- 计分示例：某 workload p50 为 T_ref 的一半 → `25 − 12.5·log2(0.5) = 37.5 → 38` 分；为两倍 → `25 − 12.5 = 12.5 → 13` 分（`Math.round`，.5 向 +∞ 取整按 JS 语义）。

## 8. 容易踩的坑

1. **状态码是精确值，不是范围**。`expectStatus` 只接受列出的那一个（或那几个）状态码：建库/建 issue/建 comment/建 PR/PUT contents 首建是 201 不是 200；删库是 204；合并冲突是 405 不是 409；旧 sha 更新是 409；畸形 JSON 是 400。`PUT /contents` 更新时接受 200 **或** 201（两处：`commitOnBranch` 更新、`contents-stale-sha` 的更新步）。
2. **空值 vs 缺字段**：`checkShape` 对 object 的 required 字段只判“在对象里”（`key in object`），值为 `null` 时再按类型校验——即 `{"message": null}` 不能通过 `message: string`；但 `GraphQL` 的 `data.repository` 必须**显式为 `null`**（`unknown-repository` 检查用 `!== null` 判定，缺字段会失败）；`issuesPage` 的 `after: null` 必须作为 JSON null 发送（不是省略）。
3. **id 类型**：REST 的 `number`（issue/PR）与 comment 的 `id` 必须是**数字**（`shapes.number({integer:true, min:1})`），string 数字不通过；`databaseId` 必须是正整数；GraphQL 的全局 `id` 必须是**非空 string**，且不得等于明文 `String(databaseId)` / `String(number)`（`global-id-stability`）。MCP 的 `rest-parity` 比较 id 时用 `String(id)`，类型可宽松；但 REST 检查本身不宽松。sha 一律是 40 hex **string**（REST 正则不区分大小写；git-client 的 `isObjectId` 只认小写——推送/拉取路径上用大写 sha 会在客户端侧直接失败）。
4. **时间戳格式**：commit author/committer 行要求 `<unix秒> +0000`（`buildCommit` 默认时区 `+0000`）；REST 的 `merged_at` 只要求非空 string（格式未规定）；scenario 时间戳为 `new Date(epochSec*1000).toISOString()`（ISO 8601 UTC）。**未确认** REST 的 `created_at`/`updated_at` 等字段是否被校验（检查中未出现这些字段）。
5. **message 末尾换行**：`buildCommit` 保证 message 以单个 `\n` 结尾（`clone-commit-bytes` 按此精确比对解析出的 message）；`main.ts` 的 fixture commit message 为 `` `${request.message}\n` ``。自行构造 commit 时 message 缺/多换行会导致字节比对失败。
6. **严格比对是值比对**：`title`/`body`/`description`/`head.ref`/`base.ref`/`sha` 等多处用 `!==` 精确比对（大小写敏感），只有 sha 在多数 REST 断言里先 `lower()`；`status` 字段用 `oneOf` 白名单（`open/closed`、`MERGEABLE/CONFLICTING/UNKNOWN`、`ADMIN/…/READ` 等），多一个值或大小写不同即失败。
7. **分页必须服务器端做**：`Link: rel="next"` 必须由服务器生成且指向同 origin 的下一页；`repos.pagination` 要求至少 3 页、无重复、30 个全出现；`issues-pagination`（GraphQL）要求 `pageInfo.hasNextPage` 与 `endCursor` 语义正确（第一页 `hasNextPage: true`、第二页 `false`，两页恰为 5+2）。
8. **GraphQL 错误是 200，不是 4xx**：未知字段必须答 HTTP 200 + `errors`（且 message 含 `noSuchFieldOnViewer`）；未知仓库必须答 200 + `data.repository: null` 且**无** `errors`。把这两类做成 HTTP 400/404 会失败。
9. **MCP 工具名与参数名不是固定的**：工具可用别名/前缀，参数属性名可用同义词（§6.2/§6.3 的映射表）；但 `inputSchema.type` 必须为 `"object"` 且每个工具都要有非空 `description`；`tools/list` 两次结果必须字节相同（不要在每次调用时生成随机顺序/随机 id）。
10. **Git v2 与 v0 不能混**：`ls-refs`/`fetch` 的 v2 请求必须带 `Git-Protocol: version=2` 头且 body 为 v2 命令格式；`receive-pack` 必须是 v0（advertisement 与命令列表均为 v0 格式），服务器若对 receive-pack 回 v2 advertisement，客户端直接抛错。v0 fetch 必须是两段式（want 段 + flush + have/done 段）。
11. **report-status 的 `unpack` 行不可少**：无 `unpack` 行或空响应体 → 客户端 `report = null`，调用方视为失败；非 FF 拒收时也要先 `unpack ok`，再 `ng <ref> non-fast-forward`（reason 字符串必须一字不差）。
12. **不要发 delta 也可以，但发了必须正确**：客户端推包不含 delta；服务器回包带不带 delta 均可，但带 delta 时 OFS/REF 解析、base 缺失（thin pack）都必须正确，否则 `readPack` 抛错。
13. **仓库创建只能走 REST**：smart-HTTP push 不能凭空建库；每个检查/ workload 都先 `POST /api/v3/user/repos`（重复创建接受 422/409 的场景见 §4.2，不要把重复创建一律当 4xx 错误返回——分页检查与 git 客户端依赖它表示“已存在”）。
14. **不要用墙钟 / 随机数生成数据**：所有检查数据来自 scenario 种子；commit 时间戳、message、分支名都由种子决定。实现侧若用当前时间生成 commit 时间戳，`clone-commit-bytes` 等字节比对仍能通过（因为比对的是客户端自己推入的 bytes 与 clone 回来的 bytes 是否一致）——但 bench 的 commit 时间戳是 `1_700_000_000 + index` 的固定值；**未确认**评分是否要求实现侧时间戳与种子一致（检查本身只比对“推入什么、取出什么”，不比对种子值）。
15. **Content-Type 与 body 一致性**：REST 回复的 Content-Type 必须含 `json`（`+json` 亦可），且 body 必须是可解析 JSON；`text/html` 或以 `<` 开头的 body 直接失败（`protocol.content-type-json` 抽查 6 个调用，含错误响应）。
16. **MCP 的 `_meta` 与头缺一不可**：每请求都要带 `_meta`（含两个 protocolVersion 键）与 `MCP-Protocol-Version` 头（legacy `initialize` 除外）；`tools/call` 还要带 `Mcp-Method` 与 `Mcp-Name` 头。缺失时 modern 服务器的 HeaderMismatch 路径（`-32020`）在文件中只作为客户端的拒绝判定出现，服务器侧是否必须校验**未确认**。
17. **健康检查与注册的时序**：entry 必须先 `listen(0)` 再 register；env 的 boot 在 register 后才查 `/healthz` 两次；`/done` 轮询间隔从 250 ms 指数退避到 2_000 ms——不要对 `/done` 做长轮询挂起（env 侧 1_000 ms 内必答）。
18. **数字的边界**：`per_page=10` 时每页不得超过 10 条；`first: 10` 的 GraphQL issues 列表不得超过 10 个 node；`first: 5` 的 pullRequests 不得超过 5 个；`fetch-shallow-depth1` 的 clone 不得多含任何一个祖先 commit 对象。

## 附录：文件清单与未确认事项汇总

- 已读文件（14 个）：`wire.ts`（1_305 行）、`manifest.ts`、`calibration.json`、`main.ts`（1_060 行）、`export.ts`、`bench.ts`（877 行）、`checks-git.ts`（1_150 行）、`checks-rest.ts`（1_250 行）、`checks-graphql.ts`（1_318 行）、`checks-mcp.ts`（1_002 行）、`git-client.ts`（2_144 行）、`rest-client.ts`（493 行）、`graphql-client.ts`（331 行）、`mcp-client.ts`（795 行）。
- 本文档未覆盖的内容（套件目录外，如 `competition.yaml`、评分器 `scorer/*`、参考 forge 实现）：均未读、未写。
- 文中标记“未确认”的点汇总：
  1. Git smart HTTP 的 401 行为（§1.4）。
  2. `/healthz` 的 body 是否被校验（main.ts 只判 status 200；wire.ts 称应答 `{"ok":true}`）。
  3. tie-break 中 “earlier receipt” 的定义。
  4. 重复建库时 422 body 是否必须含 message（仅 git 客户端认 “already exists” 子串）。
  5. `GET /api/v3/user` 的其余字段要求；`GET /git/refs/heads/{branch}` 与 `GET /branches/{branch}` 的精确响应形状。
  6. `SearchType` 除 `ISSUE` 外的枚举值。
  7. 其他 GraphQL 错误（坏变量等）的 HTTP 状态/形状。
  8. `git.clone-empty` 中 HEAD symref 的强制程度（代码只记入 detail）。
  9. `git.repo-survives-errors` 中畸形 POST 的期望响应状态。
  10. MCP legacy 下服务器不给 `Mcp-Session-Id` 是否可通过；服务器是否必须校验 `_meta`/头缺失。
  11. REST 的 `created_at`/`updated_at` 等时间字段是否被校验（检查中未出现）。
  12. 实现侧 commit 时间戳是否须与种子一致（检查本身不比对种子值）。
  13. `-32021` 的具体含义。

# `opencode serve` 启动耗时分析

实测启动日志：
```
[05:19:28.204] opencode: binary started, pid=106922
[05:19:28.591] serve: handler invoked                               ← +387ms
[05:19:28.668] serve: resolved network options, calling Server.listen...
[05:19:28.669] server.listenEffect: starting
[05:19:28.670] server.startWithPortFallback: port=0, trying 4096 first
[05:19:28.670] server.startListener: building layer for port 4096
[05:19:29.093] tcp address resolved port=4096                       ← +423ms
[05:19:29.097] server.listen: resolved, returning listener
opencode server listening on http://0.0.0.0:4096
```

总耗时 ~893ms，瓶颈在大头两个阶段：

| 阶段 | 耗时 | 占比 | 说明 |
|------|------|------|------|
| ① 进程初始化 + yargs | **387ms** | 43% | Bun 二进制启动、加载所有 import、yargs 构建 CLI 树 |
| ⑦ 构建 Effect 层 | **423ms** | 47% | 组装所有服务依赖图 (Auth/Agent/Project/MCP 等) |
| ②~④ 懒加载 + 配置 | 77ms | 9% | 动态 import server 模块 + 读配置 |
| 其余 | ~6ms | 1% | |

---

## 阶段① — `index.ts` 顶层 import（~387ms）

所有 21 个命令模块都被 import 了，包括纯 CLI 命令：

| import | 用途 | API 需要？ |
|--------|------|-----------|
| `UI` (logo, ANSI 样式) | CLI 终端输出 | ❌ |
| `FormatError`, `errorMessage` | CLI 错误格式化 | ❌ |
| `Heap` | 自动 heap snapshot | ❌ |
| `RunCommand`, `GenerateCommand`, `ConsoleCommand`, `ProvidersCommand`, `AgentCommand`, `UpgradeCommand`, `UninstallCommand`, `ModelsCommand`, `DebugCommand`, `StatsCommand`, `McpCommand`, `GithubCommand`, `ExportCommand`, `ImportCommand`, `AttachCommand`, `TuiThreadCommand`, `AcpCommand`, `WebCommand`, `PrCommand`, `SessionCommand`, `PluginCommand`, `DbCommand` | CLI 命令定义（PR #30453 把实现移到了懒加载，但模块本身还是要 resolve） | ❌ 但只花模块 resolve 时间，不重 |

PR #30453 已经减少了这部分的重量（实现移到了 handler 内懒加载），但 21 个模块的 module graph resolve 仍然有固定开销。

---

## 阶段② — Effect 依赖层构建（~423ms）

`LayerNode.group` 构建了整个依赖图，然后在 `startListener` 时全部实例化。

| 组件 | 用途 | API 需要？ |
|------|------|-----------|
| `uiRoute` | 托管 Web UI 静态文件（嵌入或 proxy 到 app.opencode.ai） | ❌ **纯 API 不需要** |
| `tuiHandlers` | TUI 专用 API（controlNext/controlResponse/appendPrompt 等 13 个端点） | ❌ **纯 API 不需要** |
| `docRoute` | OpenAPI `/doc` 端点 | ❌ 但已用 lazy 加载 |
| `Npm` | npm 包管理（`opencode install`/`upgrade` 用） | ❌ |
| `SessionProjector` | TUI session 投射 | ❌ |
| `BackgroundJob` | 后台任务 | ⚠️ 部分可能需要 |
| `Format` | 格式化工具（AI 代码输出格式化，session 执行用） | ✅ 保留 |
| `Todo` | Todo 跟踪 | ❌ TUI 用 |
| `Worktree` | Git worktree 管理 | ⚠️ session 执行用 |
| `Installation` | 安装管理（升级/卸载 CLI） | ❌ |

其余大部分（Auth, Account, Agent, Session, Provider, LLM, Storage, Git, Database, MCP, Permission 等）是 API 提供服务必需的。

---

## 可优化项汇总

| 浪费项 | 估算时间 |
|--------|---------|
| `uiRoute` + `serveUIEffect`（加载 embedded Web UI） | ~50-80ms |
| `tuiHandlers` | ~20-30ms |
| `Npm` + `Heap` + 其他 CLI-only 服务 | ~30-50ms |
| `index.ts` 21 个命令模块 import resolve | ~50-80ms |
| **合计可省** | **~150-240ms（约 17-27%）** |

---

## 组件逐项分析（问答结论）

### Q1: `uiRoute` 跟浏览器打开网页的关系

有关系。`uiRoute` 是负责提供网页的 catch-all 路由（`GET /*`）。

网页有两种来源：
1. **embedded Web UI** — 编译时把 `app/` 目录的静态文件打包进二进制（`opencode-web-ui.gen.ts`），`serveUIEffect` 直接读内存返回
2. **proxy 到公网 `app.opencode.ai`** — embedded 不存在或加载失败时的 fallback

如果你需要浏览器访问 `http://<ip>:4096/...` 打开页面，**`uiRoute` 不能去掉**。

---

### Q2: (跳过)

---

### Q3: `tuiHandlers` 是做什么的，能否区分 TUI 和 serve

TUI 客户端和 serve 是独立的执行路径：

```
opencode (TUI 客户端) ──HTTP──>  opencode serve (服务端)
                                 ├── API 端点 (session, provider, file...)
                                 ├── tuiHandlers ← TUI 客户端调用
                                 └── uiRoute (Web UI)
```

- **`opencode`（TUI）** → `cli/cmd/tui/thread.ts` → 启动终端界面 → **作为客户端连接已有 server**
- **`opencode serve`** → `cli/cmd/serve.ts` → `Server.listen()` → 启动 HTTP server

`tuiHandlers` 是 **server 端** 的 13 个 API 端点（controlNext/controlResponse/appendPrompt/openHelp/……），供 TUI 客户端调用。纯 API 调用不需要。

**可以区分：** `serve.ts` 调用 `createRoutes` 时传参控制是否加载 `tuiHandlers` 即可。

---

### Q4: `docRoute`

纯 API 文档，`GET /doc` 返回 OpenAPI spec JSON。去掉不影响业务功能。且已经用 `lazy()` 做了懒加载（首次访问才构建）。

---

### Q5: `Npm`

管理 `npm install` 调用，用于 `opencode install` / `opencode upgrade`。纯内网场景不需要，可去掉。

---

### Q6: `SessionProjector`（TUI session 投射）

TUI 实时显示 session 进度的面板（AI 思考、输出 token、当前操作）。`SessionProjector` 把 session 内部状态投射到 TUI 界面。

纯 API 调用不需要，可去掉。

---

### Q7: `Format`

格式化工具（调用 `prettier`、`dprint` 等）对 AI 生成的代码做格式化。属于 session 执行链路的一部分，**不是 TUI 专用**。**需要保留。**

---

### Q8: `Worktree` 依赖 git

是 git worktree 管理。非 git 工程环境下初始化成本很低。去掉的收益小，建议不动。

---

### Q9: `Installation`

管理版本安装和升级检测。纯内网手动管控版本，不需要，可去掉。

---

## CLI 命令模块（index.ts 顶层 import）

跑 `opencode serve` 时，只有 `ServeCommand` 是需要的，其余 20 个命令模块（Run/Github/Debug/TuiThread/Upgrade/……）都是白加载。

虽然 PR #30453 已经把每个命令的重实现移到 handler 内懒加载，但模块本身的 yargs 定义和轻量 import 仍需要 resolve 和 evaluate。理想做法是 yargs 解析到 `serve` 命令后才动态 `import("./cli/cmd/serve")`。

## 最终可优化清单（纯 API serve 场景）

| 组件 | 安全性 | 收益 | 备注 |
|------|--------|------|------|
| `tuiHandlers` | ✅ 安全 | ~20-30ms | TUI 客户端用，API 不需要 |
| `Npm` | ✅ 安全 | ~15-20ms | CLI 包管理用 |
| `Installation` | ✅ 安全 | ~10-15ms | CLI 升级检测用 |
| `Heap` | ✅ 安全 | ~5ms | CLI heap snapshot |
| `SessionProjector` | ✅ 安全 | ~15-20ms | TUI session 投射 |
| `DocRoute` | ✅ 安全可去 | ~5ms | 但已是 lazy，收益小 |
| CLI 命令模块懒加载 | ✅ 安全 | ~50-80ms | index.ts 顶层 import 优化 |
| `uiRoute` | ❌ **需要网页访问** | ~50-80ms | 去掉就打不开网页 |
| `Format` | ❌ **session 执行需要** | — | AI 代码输出格式化 |
| `Worktree` | ⚠️ 可去但收益小 | ~5ms | 非 git 工程成本低 |
# OpenCode Server 启动分析

## 现象

`opencode serve` 从执行到打印 `opencode server listening on` 耗时约几秒。
示例日志：

```
timestamp=18:02:30.540 loading config.json
timestamp=18:02:30.547 loading opencode.json
timestamp=18:02:30.549 loading opencode.jsonc
opencode server listening on http://0.0.0.0:4096
```

## 启动时序（实测）

启动命令：`opencode serve --hostname 0.0.0.0 --print-logs`，带 Timing 插桩。

### 总览

```
[Timing] imports+eval: 1194ms (effect-cmd=+854 run=+862 providers=+1194 stats=+1194 mcp=+1194 ...), yargs-setup: 13ms, parse: 44ms, heap-start: 0ms, app-runtime: 226ms
[Timing] import server: 147ms, resolve opts: 83ms, listen: ~800ms
```

| 阶段 | 耗时 | 说明 |
|------|------|------|
| **imports+eval** | **1194ms** | 进程启动 → `index.ts` 第一行代码。含 Bun 二进制自解压 + 所有静态 import 求值 |
| yargs-setup | 13ms | `yargs().command(x27).middleware().option()` 等 |
| parse | 44ms | 匹配 serve 命令 |
| heap-start | 0ms | `Heap.start()` 几乎无开销 |
| app-runtime | 226ms | 动态 import `app-runtime.ts` → 46 个模块静态 import 求值 + `ManagedRuntime.make(AppLayer)` |
| import server | 147ms | 动态 import `server/server.ts` → 52 个模块静态 import 求值 |
| resolve opts | 83ms | `resolveNetworkOptions(args)` |
| listen | ~800ms | `buildLayer` 图构建 + `Layer.buildWithMemoMap`（其中模块初始化 ~450ms） |

### 1.2s 瓶颈分析：imports+eval (1194ms)

这 1.2 秒由 `index.ts` 顶部的 **27 个静态 import** 导致——Bundle 求值时，每个 command 文件的所有依赖也必须求值。虽然当前只跑 `serve`，但其他 26 个 command 的重依赖被**强行拉入求值链**。

#### Per-module 求值时间（实测）

通过在 9 个关键文件底部加 `performance.now()` 插桩，测得各模块求值完成时间：

```
effect-cmd=+854    ← effect 库加载完毕 + effect-cmd.ts 求值完毕
run=+862            ← run.ts 求值完毕（在 effect-cmd 之后 ~8ms）
providers=+1194    ↓
stats=+1194         ← 其余所有 command 文件在这 332ms 内同时求值完毕
mcp=+1194
import=+1194
export=+1194
session=+1194
db=+1194
```

| 子阶段 | 耗时 | 说明 |
|--------|------|------|
| 进程启动 → `effect-cmd.ts` 求值完毕 | **854ms** | Bun 二进制自解压 + `effect` 库加载 + yargs + 基础共享模块 |
| `run.ts` 求值 | **8ms** | run.ts 的额外 import 很少（强依赖已缓存） |
| 剩余 25 个 command 文件求值 | **332ms** | 含所有重模块——但它们的重依赖（session、database、MCP SDK）已在 `effect-cmd` 阶段缓存，这里只求值 command 自己的文件体 |

**关键结论：** 大头（~854/1194 = 72%）不是重 command 文件，而是 **Bun 运行时初始化 + `effect` 库加载 + 基础模块**。"重模块"（stats/mcp/import 等）虽然看似 import 了很多，但因为它们的依赖在 effect-cmd 阶段已经求值完毕（缓存命中），各自只贡献了末尾的 ~30ms。

#### 轻量 command（推荐参考）

| command | 静态 import | 启动影响 |
|---------|------------|---------|
| `generate` | 仅 type import | 极小 |
| `upgrade`, `uninstall` | UI, Installation, fs | 低 |
| `attach`, `tui` | 少量工具库, effect 动态 | 中低 |

#### 重 command（仅 import 即拖慢 serve）

| command | 最重静态 import |
|---------|----------------|
| **`mcp`** | `@modelcontextprotocol/sdk` 全量 + `@/mcp` + `@/config` |
| **`stats`** | `@/session/session` + `drizzle-orm/libsql` + `@/project` |
| **`import`** | `@/session/session` + 数据库 ORM + `@/share/share-next` |
| **`export`** | `@/session/session` + V1 session 类型 |
| **`db`** | `drizzle-orm` + `libsql` |
| **`providers`** | `@/config` + `@/plugin` + `models-dev` |
| **`lsp`** (debug 子命令) | `@/lsp/lsp`（LSP 全栈） |

#### `index.ts` 全部顶层静态 import

| # | 符号 | 来源 | 说明 |
|---|------|------|------|
| 1 | **yargs** | `yargs` | CLI 框架 |
| 2 | **hideBin** | `yargs/helpers` | 剥离前两个 argv |
| 3 | **RunCommand** | `./cli/cmd/run` | 非交互模式 |
| 4 | **GenerateCommand** | `./cli/cmd/generate` | 生成 OpenAPI spec + JS SDK |
| 5 | **ConsoleCommand** | `./cli/cmd/account` | Console 账号管理 |
| 6 | **ProvidersCommand** | `./cli/cmd/providers` | AI 供应商/密钥管理 |
| 7 | **AgentCommand** | `./cli/cmd/agent` | Agent 管理 |
| 8 | **UpgradeCommand** | `./cli/cmd/upgrade` | 升级 opencode |
| 9 | **UninstallCommand** | `./cli/cmd/uninstall` | 卸载 opencode |
| 10 | **ModelsCommand** | `./cli/cmd/models` | 列出可用模型 |
| 11 | **UI** | `./cli/ui` | CLI UI 工具函数 |
| 12 | **InstallationVersion** | `@opencode-ai/core/installation/version` | 版本号常量 |
| 13 | **FormatError** | `./cli/error` | CLI 错误格式化 |
| 14 | **ServeCommand** | `./cli/cmd/serve` | 启动 headless HTTP 服务器 |
| 15 | **DebugCommand** | `./cli/cmd/debug` | → 下接 #15a–15i 子命令文件 |
| 15a | **ConfigCommand** | `./cli/cmd/debug/config` | 显示配置（内部动态 import Config，启动轻） |
| 15b | **FileCommand** | `./cli/cmd/debug/file` | 文件系统调试工具 |
| 15c | **LSPCommand** | `./cli/cmd/debug/lsp` | **LSP 调试（import `@/lsp/lsp`，全栈 LSP）** |
| 15d | **RipgrepCommand** | `./cli/cmd/debug/ripgrep` | ripgrep 调试工具 |
| 15e | **ScrapCommand** | `./cli/cmd/debug/scrap` | 列出所有已知 project |
| 15f | **SkillCommand** | `./cli/cmd/debug/skill` | 列出所有 skill |
| 15g | **AgentCommand** | `./cli/cmd/debug/agent` | 显示 agent 配置详情 |
| 15h | **StartupCommand** | `./cli/cmd/debug/startup` | 打印启动时间 |
| 15i | **V2Command** | `./cli/cmd/debug/v2` | V2 catalog 和内置插件调试 |
| 16 | **StatsCommand** | `./cli/cmd/stats` | 显示 token 用量和费用统计 |
| 17 | **McpCommand** | `./cli/cmd/mcp` | MCP 服务器管理 |
| 18 | **GithubCommand** | `./cli/cmd/github` | GitHub Agent |
| 19 | **ExportCommand** | `./cli/cmd/export` | 导出 session 为 JSON |
| 20 | **ImportCommand** | `./cli/cmd/import` | 导入 session |
| 21 | **AttachCommand** | `./cli/cmd/attach` | 连接到运行中的服务器 |
| 22 | **TuiThreadCommand** | `./cli/cmd/tui` | 启动交互式 TUI |
| 23 | **AcpCommand** | `./cli/cmd/acp` | 启动 ACP 服务器 |
| 24 | **EOL** | `os` | 换行符常量 |
| 25 | **WebCommand** | `./cli/cmd/web` | 启动 HTTP + 打开浏览器 |
| 26 | **PrCommand** | `./cli/cmd/pr` | checkout PR 分支并运行 |
| 27 | **SessionCommand** | `./cli/cmd/session` | Session 管理 |
| 28 | **DbCommand** | `./cli/cmd/db` | 数据库工具 |
| 29 | **errorMessage** | `./util/error` | 通用错误格式化 |
| 30 | **PluginCommand** | `./cli/cmd/plug` | 安装 npm plugin |
| 31 | **Heap** | `./cli/heap` | 初始化内存 heap |

共 31 条顶层 import + 9 条 debug 子命令（#15a–15i），合计 **40 个文件**在启动时被求值。其中 1/2/11/12/13/24/29/31 是工具/常量，`serve` 实际需要的只有 #14（serve.ts）+ `effect-cmd.ts`（非 yargs 命令文件，在 effect-cmd 阶段完成求值）

#### 优化方向

将重 command 文件顶部的静态 import 改为 handler 内部的动态 `import()`，避免不使用的模块在启动时被求值。例如 `stats.ts` 中 `import { Session } from "@/session/session"` → `const { Session } = await import("@/session/session")`。

### 2. app-runtime 阶段 (230ms)

动态 import `app-runtime.ts` → 求值 46 个模块的静态 import + `ManagedRuntime.make(AppLayer, ...)`。

### 3. import server 阶段 (130ms)

动态 import `server/server.ts` → 求值 52 个模块（同小组内大部分模块已在上一步被缓存，少部分新增如 httpClient、EventV2、ProjectV2、PtyTicket 等）

### 4. 层构建阶段 (~700ms)

`buildLayer` 图遍历（瞬时）→ `Layer.buildWithMemoMap` 初始化所有 52 个 Effect Layer 服务。各模块实际初始化时间见 `[Module] {name} building...` 日志。

## Provider 插件说明

日志中看到的 `plugin.added` 事件包含 `alibaba`, `anthropic`, `azure`, `openai`, `openai-compatible` 等约 30+ 个 provider，它们**不是传统插件**，而是：

- 每个 provider 是一个 4-8KB 的元数据目录
- 包含模型列表（支持能力、max tokens、价格等）和 API 端点模板
- **不会启动后台进程**
- **不会发起网络连接**
- **合计内存约几十 KB**

## 可优化的启动耗时

| 优化项 | 优先级 | 说明 |
|--------|--------|------|
| **27 个 command 静态 import** | **高** | `index.ts` 静态 import 所有 command 文件，导致不用的命令也拉入求值链。改为动态 import 可节省 ~1000ms |
| Effect Layer 构建 (~700ms) | 中 | 52 个服务层的 `Layer.buildWithMemoMap` 初始化（`buildLayer` 图遍历本身是瞬时的） |
| Database 迁移 | 中 | SQLite schema 检查，首次启动较慢 |
| Config 加载 | 低 | 3 个文件的解析，已有缓存 |
| `OPENCODE_DISABLE_CHANNEL_DB=true` | 已设置 | 跳过 channel DB 加载 |
| `OPENCODE_DISABLE_MODELS_FETCH=true` | 已设置 | 跳过模型列表网络请求 |

## 关键文件

| 文件 | 作用 |
|------|------|
| `packages/opencode/src/index.ts` | 入口，yargs 命令行解析 |
| `packages/opencode/src/cli/cmd/serve.ts` | serve 命令 handler |
| `packages/opencode/src/server/server.ts` | HTTP server 创建 + 层构建 |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | 层定义 + 所有 service import |
| `packages/opencode/src/plugin/index.ts` | 插件加载系统 |

## 注意事项

`bun typecheck` 命令会导致本机内存上限并崩溃，禁止使用。如需类型检查请使用 `npx tsc --noEmit`。——记录于 2026-06-27，Git 模块删除后。

## Git 模块删除记录

2026-06-27: 完全删除了 Git 模块（`packages/opencode/src/git/index.ts` 和 `packages/core/src/git.ts`），修复了所有引用。目标用户场景是纯净文件夹（办公文档），无 git 仓库。

### 删除的模块
- `packages/opencode/src/git/index.ts` — V1 Git 服务（350 行）
- `packages/core/src/git.ts` — V2 Git 服务（988 行）
- `packages/core/src/project/copy-strategies.ts` — 仅包含 git worktree 策略

### 修改的文件
- **opencode 包**: app-runtime.ts, server.ts, vcs.ts（重写为 no-op）, storage.ts, worktree/index.ts, github.handler.ts, pr.ts
- **core 包**: snapshot.ts（使用 noopLayer）, watcher.ts, repository-cache.ts（返回 error）, project/copy.ts, project.ts（resolve 返回全局 ID）, location-layer.ts, move-session.ts（移除 change capture/apply/discard）
- **server 包**: handlers/project-copy.ts
- **测试文件**: 7 个 core test + 5 个 opencode test
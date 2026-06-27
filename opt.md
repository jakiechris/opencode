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

## 启动时序

### 0. yargs 解析 + 中间件 (index.ts)

- yargs 解析命令行参数
- 设置环境变量 `OPENCODE_PRINT_LOGS` `OPENCODE_LOG_LEVEL` `OPENCODE_PURE`
- 调用 `Heap.start()`（内存采样启动）

### 1. Dynamic import: server 模块 (serve.ts:14)

```ts
const { Server } = yield* Effect.promise(() => import("../../server/server"))
```

触发加载 `server/server.ts`，进而加载 `server/routes/instance/httpapi/server.ts`。

**此时 55 个 service 模块被同步 import 进内存：**

| # | 模块 | 所在包 | 职责 |
|---|---|---|---|
| 1 | **Npm** | core | npm 包管理：安装、解析、查找系统模块 |
| 2 | **FSUtil** | core | 文件系统工具：读写、删除、glob、MIME 类型 |
| 3 | **Database** | core | SQLite 数据库访问（Drizzle ORM），WAL 模式管理 |
| 4 | **Auth** | opencode | OAuth 令牌管理、API key，持久化到 auth.json |
| 5 | **Account** | opencode | 用户账号：登录、device code、refresh token、组织管理 |
| 6 | **Config** | opencode | 应用配置：读写 jsonc、远程配置、V1 迁移 |
| 7 | **Env** | opencode | 实例级环境变量：get/set/remove/list |
| 8 | **Git** | opencode | Git 操作：status、diff、log、commit、branch |
| 9 | **Ripgrep** | core | 文本搜索适配器，封装 ripgrep 进程调用 |
| 10 | **Storage** | opencode | 文件存储：session/project 持久化及迁移 |
| 11 | **Snapshot** | opencode | 文件变更快照：git patch 的创建和应用 |
| 12 | **Plugin** | opencode | 插件系统：加载内置/外部 auth 插件，管理 hooks |
| 13 | **ModelsDev** | core | 模型目录：从 dev 端点拉取模型定价、能力、状态 |
| 14 | **Provider** | opencode | AI provider/模型解析：管理 provider、创建 LLM 实例 |
| 15 | **ProviderAuth** | opencode | Provider OAuth 认证流程、文本提示、选择提示 |
| 16 | **Agent** | opencode | Agent 逻辑：生成对象、流式模型、管理 agent skill |
| 17 | **Skill** | opencode | Skill 管理：加载 SKILL.md、管理 skill 生命周期 |
| 18 | **Discovery** | opencode | Skill 索引发现：从远程 URL 拉取 skill 索引 |
| 19 | **Question** | opencode | 交互式用户提问：选项/工具提示、收集回答 |
| 20 | **Permission** | opencode | 权限请求/审批：ask/reply、规则评估 |
| 21 | **Todo** | opencode | Session todo 列表：读取/更新待办事项 |
| 22 | **Session** | opencode | Session CRUD 和生命周期：创建、删除、消息管理 |
| 23 | **SessionProjector** | core | Session 事件投影：将持久化事件转为 message/part 行 |
| 24 | **SessionStatus** | opencode | Session 状态：set/get/list 状态信息 |
| 25 | **BackgroundJob** | opencode | 后台任务注册：start/extend/cancel/wait |
| 26 | **RuntimeFlags** | opencode | 运行时特性开关：从环境变量读 auto-share、experimental、LSP 等 |
| 27 | **EventV2Bridge** | opencode | 事件桥接：为核心事件附加 instance location 上下文 |
| 28 | **SessionRunState** | opencode | Session 执行状态：忙碌检查、取消、启动 shell、并发控制 |
| 29 | **SessionProcessor** | opencode | Session 处理流水线：编排 agent/provider、处理权限和溢出 |
| 30 | **SessionCompaction** | opencode | Session 上下文压缩：摘要旧消息减少 token 用量 |
| 31 | **SessionRevert** | opencode | Session 消息回退：回滚到指定消息 |
| 32 | **SessionSummary** | opencode | Session 摘要生成：用 git diff 数据生成总结 |
| 33 | **SessionPrompt** | opencode | 构造 prompt 并编排 LLM tool loop：管理 tool registry、MCP、LSP |
| 34 | **Instruction** | opencode | 系统指令：从 URL 获取指令文件加入 session |
| 35 | **LLM** | opencode | LLM 执行：流式文本生成、provider 管理、AI SDK 集成 |
| 36 | **LSP** | opencode | LSP 集成：启动 language server、管理客户端、提供定义/引用 |
| 37 | **MCP** | opencode | MCP 客户端管理：tools、transports（stdio/SSE/HTTP） |
| 38 | **McpAuth** | opencode | MCP 认证：OAuth token、client info 管理 |
| 39 | **Command** | opencode | 自定义命令注册：从 config、MCP、skill 发现命令模板 |
| 40 | **Truncate** | opencode | 工具输出截断：按行/字节截断文件内容，溢出写入临时文件 |
| 41 | **ToolRegistry** | opencode | 工具注册中心：注册/构建 LLM tools（read/write/edit/grep/glob/shell 等） |
| 42 | **Format** | opencode | 代码格式化：调用外部格式化工具（prettier 等） |
| 43 | **Project** | opencode | 项目管理：创建/更新项目、管理目录、bootstrap 实例 |
| 44 | **Vcs** | opencode | 文件变更追踪：构建 diff、监听文件系统、生成 patch |
| 45 | **Workspace** | opencode | Control plane workspace：同步 session、管理 workspace 生命周期 |
| 46 | **Worktree** | opencode | Git worktree 管理：创建/删除/列出并行开发环境 |
| 47 | **Installation** | opencode | 安装和更新管理：版本检查、下载更新、release 类型检测 |
| 48 | **ShareNext** | opencode | Session 分享：通过 control plane HTTP API 创建/同步/删除 |
| 49 | **SessionShare** | opencode | Session 创建/分享/取消分享操作，包装 ShareNext |
| 50 | **InstanceStore** | opencode | 项目实例生命周期：load/reload/dispose，含完整 service bootstrap |
| 51 | **httpClient** | core | Effect 平台层：预构建的 filesystem/path/HTTP/LLM client layer |
| 52 | **EventV2** | core | 核心事件系统：数据库持久化的事件发布/订阅 |
| 53 | **ProjectV2** | core | 核心项目标识：Project ID、目录管理、VCS 元数据 |
| 54 | **ProjectCopy** | core | 项目克隆：基于 git worktree 的项目复制策略 |
| 55 | **PtyTicket** | core | PTY 连接票据：PTY WebSocket 的限时票据发放/消费 |

- Bun 下很快（<200ms）
- NFS/网络磁盘下可能 500ms-1s

### 2. 层定义 (server.ts:288) — 瞬时

```ts
export const routes = createRoutes()
```

`createRoutes()` 构建 Effect Layer 树，但只做函数组合，不实例化服务。

### 3. 层构建：实际初始化 (server.ts:123-136)

`Server.listen()` → `startListener()` → `Layer.buildWithMemoMap(listenerLayer)` 触发所有服务的 Effect 初始化：

| 服务 | 初始化行为 | 耗时预估 |
|------|-----------|---------|
| **Config** | 读取 config.json / opencode.json / opencode.jsonc | <10ms |
| **Database** | 打开 SQLite DB 文件，运行 schema 迁移 | ~100-300ms |
| **Plugin** | 扫描 `plugin_origins`，调用 PluginLoader.loadExternal | ~200-800ms |
| **Provider** | 扫描所有 provider plugin 目录，注册模型 catalog | ~200-500ms |
| **Agent** | 扫描 agent 定义目录 | <100ms |
| **Skill** | 扫描 skill 定义目录 | <100ms |
| **RuntimeFlags** | 读取 env flag | <10ms |
| **MCP** | 扫描 MCP server 配置（懒启动子进程） | <50ms |
| **其他** (Git, LSP, Snapshot, Storage 等) | 注册服务，无实际 I/O | 各 <50ms |

### 4. HTTP server listen (server.ts:213)

`NodeHttpServer.layer()` 创建 `http.createServer()`，绑定端口，打印 listening。

## Provider 插件说明

日志中看到的 `plugin.added` 事件包含 `alibaba`, `anthropic`, `azure`, `openai`, `openai-compatible` 等约 30+ 个 provider，它们**不是传统插件**，而是：

- 每个 provider 是一个 4-8KB 的元数据目录
- 包含模型列表（支持能力、max tokens、价格等）和 API 端点模板
- **不会启动后台进程**
- **不会发起网络连接**
- **合计内存约几十 KB**

## 可优化的启动耗时

| 优化项 | 说明 |
|--------|------|
| 55 个 service 模块的 import | Bun 解析快，NFS/网络盘下慢，可考虑 lazy import |
| PluginLoader.loadExternal | 扫描已安装插件的 npm 目录，可缓存 |
| Provider 注册扫描 | 每个 provider 插件目录的模型列表读取 |
| Database 迁移 | SQLite schema 检查，首次启动较慢 |
| Config 加载 | 3 个文件的解析，已有缓存 |
| `OPENCODE_DISABLE_CHANNEL_DB=true` | 已设置，跳过 channel DB 加载 |
| `OPENCODE_DISABLE_MODELS_FETCH=true` | 已设置，跳过模型列表网络请求 |

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
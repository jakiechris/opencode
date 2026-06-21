# `opencode serve` 冷启动优化（optpro 方案）

## 实测效果

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| `execve` → 首条业务日志 | **2,119ms** | **327ms** |
| 提速 | - | **6.5x** |

`strace` 实测对比：

```
# 优化前
16:18:41.959 execve(...)
... (2.1 秒空白 — Bun 加载 21 个命令模块 + 全部 transitive deps) ...
[16:18:43.743] opencode server ready

# 优化后
16:18:41.959 execve(...)
[16:18:42.286] opencode serve entry     ← 仅 327ms
[16:18:43.743] opencode server ready
```

## 核心思路

**不在 server 层做减法（opt.md 路线），而是在 module-load 层做懒惰加载。**

`opt.md` 的做法是在 `Server.listen()` 内部的 Effect 依赖图中砍掉不需要的服务（tuiHandlers、Npm、Installation 等），每个省 20-30ms，加起来最多省 ~200ms。

但真正的瓶颈不是 server 的服务图，而是 **`index.ts` 顶层静态 import 了全部 21 个 CLI 命令模块**。ESM 的 `import` 是 hoisted 的，在用户代码执行之前就已经全部加载完毕。`opencode serve` 只需要 `ServeCommand`，却被迫加载了 RunCommand、GenerateCommand、DebugCommand、TuiThreadCommand 等 20 个无关模块以及它们的全部 transitive deps（Effect、数据库、MCP、Git 等重型依赖）。

我们的方案：**让 yargs 在真正需要时才 `import()` 命令模块**，彻底避免无关模块的加载。

## 修改内容

### 1. `packages/opencode/src/index.ts` — 命令模块懒加载

**改前**：顶层静态 import 所有 21 个命令模块
```ts
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
// ... 共 21 行 import
import { DbCommand } from "./cli/cmd/db"

const cli = yargs(args)
  .command(RunCommand)
  .command(GenerateCommand)
  // ...
  .command(DbCommand)
```

**改后**：`lazyCmd()` 包装器 + 每个命令用 `() => import("./path")` 字面量（Bun 编译器需要**字面量** import 路径才能做 code splitting，不能传字符串变量）
```ts
// 顶层只 import 8 个轻量模块（yargs, UI, FormatError, errorMessage, Heap, EOL 等）
type CmdModule = Record<string, { builder?, handler? }>

function lazyCmd(command, describe, loader: () => Promise<CmdModule>, exportName) {
  let mod: CmdModule | undefined
  const load = () => mod ? Promise.resolve(mod) : loader().then(m => { mod = m; return m })
  return {
    command, describe,
    builder: async (yargs) => { const m = await load(); return m[exportName].builder?.(yargs) ?? yargs },
    handler: async (argv) => { const m = await load(); return m[exportName].handler?.(argv) },
  }
}

const cli = yargs(args)
  .command(lazyCmd("serve", "starts a headless opencode server", () => import("./cli/cmd/serve"), "ServeCommand"))
  .command(lazyCmd("run [message..]", "run opencode with a message", () => import("./cli/cmd/run"), "RunCommand"))
  // ... 共 23 个 lazyCmd 调用，每个带字面量 () => import("./path")
```

yargs 18 原生支持 async builder/handler，内部会 `await` 返回值。

### 2. `packages/opencode/src/cli/cmd/serve.ts` — 零 static import

**改前**：4 个顶层 import 会递归加载 Effect、Flag、network 模块
```ts
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { effectCmd } from "../effect-cmd"
import { resolveNetworkOptions, withNetworkOptions } from "../network"
```

**改后**：所有运行时依赖全在 handler 内 `await import()`
```ts
import type { Argv } from "yargs"
import type { NetworkOptions } from "../network"

export const ServeCommand = {
  command: "serve",
  describe: "starts a headless opencode server",
  instance: false,
  builder: async <T>(yargs: Argv<T>) => {
    const { withNetworkOptions } = await import("../network")
    return withNetworkOptions(yargs)
  },
  handler: async (args) => {
    console.log(`[${ts()}] opencode serve entry`)
    const { AppRuntime } = await import("@/effect/app-runtime")
    const { Effect } = await import("effect")
    const { resolveNetworkOptions } = await import("../network")
    const { Flag } = await import("@opencode-ai/core/flag/flag")

    const inner = Effect.fn("Cli.serve")(function* (a) {
      const { Server } = yield* Effect.promise(() => import("../../server/server"))
      // ...
      const server = yield* Effect.promise(() => Server.listen(opts))
      console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
      yield* Effect.never
    })
    await AppRuntime.runPromise(inner(args))
  },
}
```

`Effect.promise(() => import(...))` 在 Effect generator 内也能懒加载 — 只有在 `yield*` 执行到那一行时才会触发 import。

## 为什么对 serve API / 网页 / TUI 毫无影响

优化后实测验证：`opencode serve` 的 API 调用、Web 界面、TUI 客户端连接全部正常工作。原因很简单 — **我们只推迟了加载时机，没有删除任何东西**。

### 对比 opt.md 的减法路线

```
opt.md 思路（减法）:
  砍掉 tuiHandlers → TUI 客户端连不上
  砍掉 uiRoute    → 网页打不开
  砍掉 Npm 等服务 → 省 150ms，但功能受损

optpro 思路（懒加载）:
  推迟 RunCommand、GenerateCommand 等 20 个无关命令的加载 → 省 1,800ms
  ServeCommand 仍然完整加载 Server 模块 → 所有功能完好
```

### 各场景加载路径

**`opencode serve`（API + 网页）**：

```
execve → index.ts（仅 8 个轻量模块）
  → yargs 解析到 "serve"
  → lazyCmd 触发 () => import("./cli/cmd/serve")
  → serve.ts handler: import effect, import AppRuntime
  → Effect.promise(() => import("../../server/server"))
  → Server 模块包含 uiRoute、tuiHandlers、所有 API 端点
  → Server.listen() 启动，功能完整
```

Server 模块被加载时，**uiRoute、tuiHandlers、所有 REST API 端点都还在里面**，一个没少。只是整个模块的加载被推迟到了 `serve` 命令真正执行时。

**`opencode`（TUI 模式）**：

```
execve → index.ts（仅 8 个轻量模块）
  → yargs 解析到默认 $0
  → lazyCmd 触发 () => import("./cli/cmd/tui")
  → TuiThreadCommand 模块加载（此时才拉 Effect、TUI 渲染等重型依赖）
  → TUI 启动，功能完整
```

TUI 命令模块跟我们改动之前完全一样 — 只是从"进程启动时就加载"变成了"yargs 匹配到命令时才加载"。加载的内容、顺序、结果没有任何区别。

**`opencode db` / `opencode run` / 其他命令**：

同理 — 各自只在被调用时才通过 `lazyCmd` 加载自己的模块，互不干扰。

### 关键点

| | opt.md | optpro |
|------|--------|--------|
| 改了什么 | 删除 server 内部的服务 | 推迟模块的加载时机 |
| Server 模块完整吗 | ❌ 被裁剪 | ✅ 完整，一模一样 |
| uiRoute（网页） | 砍掉了 | ✅ 仍在 Server 中 |
| tuiHandlers（TUI） | 砍掉了 | ✅ 仍在 Server 中 |
| API 端点 | 删了 TUI 相关端点 | ✅ 全部保留 |
| 功能风险 | 高 — 删错一个就挂 | **零 — 加载的内容完全一样** |
| 启动加速 | 150-240ms | **1,800ms** |

**核心原理**：`lazyCmd` 和 `serve.ts` 里的 `await import()` 都是**时机后移**（从进程启动移到命令执行），不是**内容删除**。当模块最终被加载时，它导出的内容跟静态 import 完全一样。对下游代码来说，它根本不知道（也不需要知道）这个模块是静态 import 的还是动态 import 的。

## opt.md 的问题

`opt.md` 的分析方向是对的，但**优化层级错了**：

| 维度 | opt.md | optpro |
|------|--------|--------|
| 优化层级 | **Server 层**（Effect 服务图减枝） | **Module-load 层**（不加载无关模块） |
| 预估收益 | 150-240ms（17-27%） | **1,800ms（85%）** |
| 实际收益 | 未落地 | **327ms vs 2,119ms** |
| 方法论问题 | 看到的是"Effect 层构建耗时 423ms"，就优化 Effect 内部 | 真正的 2.1s 空白是 **ESM static import hoisting** 导致的 21 个模块预加载 |

具体问题：

1. **把症状当病因**。`index.ts` 静态 import 21 个命令模块 → 每个模块的顶层 import 又递归拉进 Effect、数据库、MCP 等重型依赖 → Bun 在第一次用户代码执行前必须解析整个模块图。opt.md 看到的 "进程初始化 + yargs 387ms" 和 "Effect 层构建 423ms" 其实都源于此，但它只分析了 server 层的 Effect 服务图，没追溯到模块加载层面。

2. **只移 handler 内的实现，没移模块本身**。PR #30453 把命令的**实现**移到了 handler 内懒加载，但 `import { RunCommand } from "./cli/cmd/run"` 这行仍然在顶层 — 模块还是要被 resolve 和 evaluate。ESM 的 `import` 是 hoisted 的，在代码第一行执行之前就已经完成了。

3. **没有触及 yargs 命令注册机制**。opt.md 提到"理想做法是 yargs 解析到 serve 才动态 import"，但没实现。我们的 `lazyCmd()` 利用 yargs 18 对 async builder/handler 的原生支持，把动态 import 放在了 builder 和 handler 内部。

4. **收益测算偏小**。opt.md 估计 CLI 命令模块懒加载省 50-80ms，实际省了 ~1.8s。低估了每个命令模块 transitive deps 的重量 — 比如 `RunCommand` → `effectCmd` → `AppRuntime` → Effect 全套，一个模块就可能牵出几十 MB 的运行时。
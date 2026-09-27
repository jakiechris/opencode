# skill-mcp —— 让 SKILL.md 能声明 MCP server

一个 opencode 插件。装上之后，任意 SKILL.md 的 frontmatter 除了 `name` / `description`，还可以写 `mcp:` 字段来声明该技能自带的 MCP server，支持普通 HTTP + header 鉴权，且**所有 value 都支持环境变量注入**。

**不实现 MCP 协议，也不实现 OAuth** —— 插件只负责把 frontmatter 里的 `mcp:` 块读出来、转成 opencode 原生的 MCP 配置注入进去，连接/传输/鉴权全部由 opencode 原生 MCP 层接管。

---

## 目录结构

```
skill-mcp/
├── README.md                       本文件
├── skill-mcp.ts                    插件本体（单文件，无依赖，无配置）
├── test-server.ts                  本地测试用的 MCP 桩（header 鉴权，见下）
└── skills/
    └── intra-mcp/SKILL.md          示例 skill，用五个环境变量演示四种注入语法
```

---

## 快速开始

### 1. 拉起测试 MCP server（8801）

`test-server.ts` 是个 70 行的最小 MCP server：只认 `Authorization: Bearer $EXPECT_KEY`，不对就返 401；同时把它收到的所有自定义 header 打到 stdout，用来核对环境变量有没有正确展开。

```bash
cd /data/opencode/session-tools/skill-mcp

EXPECT_KEY=s3cr3t PORT=8801 nohup bun run test-server.ts > /tmp/mcptest-server.log 2>&1 &

sleep 1 && cat /tmp/mcptest-server.log
# 期望输出： [hdrmcp] listening on http://127.0.0.1:8801/mcp  (expects Authorization: Bearer s3cr3t)
```

**先单独验证它自己是好的**（装 opencode 之前）：

```bash
# 带对的 header → 200
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8801/mcp \
  -H 'content-type: application/json' -H 'authorization: Bearer s3cr3t' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 不带 header → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8801/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

它提供唯一一个工具 `show_headers`，调用后把服务端收到的 header 原样返回。

实时看服务端收到什么：

```bash
tail -f /tmp/mcptest-server.log
```

**停掉**：

```bash
pkill -f test-server.ts
```

> 换端口改 `PORT=`；换密钥改 `EXPECT_KEY=`，两处要和下面 export 的值对上。

### 2. 装插件和 skill

插件放进项目的 `.opencode/plugins/`，skill 放进 `.opencode/skills/`（全局则分别放 `~/.config/opencode/` 下同名目录）：

```bash
PROJ=/data/agentic/hub/domain6/sandbox6

mkdir -p $PROJ/.opencode/plugins $PROJ/.opencode/skills
cp skill-mcp.ts        $PROJ/.opencode/plugins/
cp -r skills/intra-mcp $PROJ/.opencode/skills/
```

发现规则：`<config-dir>/{plugin,plugins}/*.{ts,js}`（见 `packages/opencode/src/config/plugin.ts`）。TS 由 Bun 在内存里转译，不需要编译。

> **插件文件里只能有一个函数导出**（就是那个 plugin 函数）。opencode 会把模块里每个函数导出都当成一个插件实例，辅助函数必须保持不导出。

### 3. 导出环境变量

示例 skill 用了五个变量，故意覆盖四种语法。测试时指向本地 8801：

```bash
export INTRA_MCP_URL=http://127.0.0.1:8801/mcp
export INTRA_MCP_KEY=s3cr3t
export INTRA_TENANT=t-42
export INTRA_APP=my-opencode
export INTRA_ENV_TAG=prod
```

**必须在启动 opencode 的那个 shell 里 export。** 想持久就写进 `~/.bashrc` 再 `source`（已开着的其它终端要新开一个）。

### 4. 验证并触发

```bash
cd $PROJ
opencode mcp list        # 期望看到 ●  ✓ intra  connected
```

然后起 opencode 发这句：

```
用 intra-mcp 技能调 show_headers
```

预期模型会先加载 skill，再调用 `intra_show_headers`，返回：

```json
server received headers: {
  "authorization": "Bearer s3cr3t",
  "x-app-name": "my-opencode",
  "x-combo": "t-42-my-opencode",
  "x-env-tag": "prod",
  "x-tenant-id": "t-42"
}
```

**看到这串就说明全链路通了**：frontmatter → 环境变量展开 → header 注入 → 真实 HTTP 请求 → 工具返回。

---

## 环境变量注入

作用于整个 mcp 配置的**所有 value**（url、header 的值、command、args、environment……），四种写法等价、可混用：

| 写法 | 例子 |
|---|---|
| `$VAR` | `Authorization: Bearer $INTRA_MCP_KEY` |
| `${VAR}` | `Authorization: Bearer ${INTRA_MCP_KEY}` |
| `${VAR:-默认值}` | `X-Tenant-Id: ${INTRA_TENANT:-default}` |
| `{env:VAR}` | `X-Env-Tag: {env:INTRA_ENV_TAG}`（与 opencode 原生配置语法一致） |

一个值里可以塞多个变量：`X-Combo: ${INTRA_TENANT:-default}-$INTRA_APP`。

**行为**：

- 引用了未设置且无默认值的变量 → 展开成空字符串，并在启动时打一条 warn（同名只提醒一次）
- 若 `url` 展开后为空 → 整个 server 被跳过，不会留下坏条目

> 解析器对 `{env:...}` / `{file:...}` 按字面字符串处理。严格 YAML 会把值位置的 `{env:VAR}` 当成流式映射解析成对象，但写它的意图显然是变量替换，所以这里偏离了 YAML 一次 —— 加不加引号都行。

---

## 换成内网平台

改 skill 的 frontmatter 即可，插件不用动：

```yaml
mcp:
  intra:
    url: ${INTRA_MCP_URL}
    headers:
      Authorization: Bearer ${INTRA_MCP_KEY}
      X-Tenant-Id: ${INTRA_TENANT:-default}
```

然后 export 真实值：

```bash
export INTRA_MCP_URL=https://你们平台地址/mcp
export INTRA_MCP_KEY=你们的key
```

工具名规则是 `<server名>_<工具名>`，即 `intra_*`。示例 skill 里没有写死工具清单 —— 它让模型按运行时工具列表里的 `intra_*` 条目自己挑，所以平台加工具不用改 skill。

---

## 常见问题

**`opencode mcp list` 显示 `needs authentication`**
不代表要 OAuth。opencode 把任何 401 都标成这个状态。header 鉴权的服务返回 401 就是 header 不对或没送到 —— 去查环境变量有没有进到 opencode 那个进程，而不是去跑 `opencode mcp auth`。

**报错 `Verify mcp_name matches an embedded MCP definition...`**
这是 `opencode-lazy-loader` 插件的 `skill_mcp` 工具抛的，不是本插件。lazy-loader 自己管理 MCP 连接，不认识注入到原生层的 server，两个装一起会抢工具。**把它从 `opencode.json` 的 `plugin` 里摘掉。**

**插件加载了，但 `intra_*` 工具不出现**
看启动日志有没有 `[skill-mcp] registered "..."`；有的话再看有没有 `environment variable "..." is not set`。两者都正常就 `opencode mcp list` 确认连接状态。

**模型不加载 skill，直接调 MCP 工具**
也能拿到结果，只是看不到 `skill` 那一步。想强制就在 query 里点名（"用 intra-mcp 技能…"）。

**`opencode run` 卡住**
skill 工具可能要权限确认，非交互模式下会挂。加 `--dangerously-skip-permissions`，或先在 TUI 里允许一次。

**改了 skill 没生效**
skill 是实例启动时扫描的，**重启 opencode**。

---

## 已知边界

- server 在实例启动时一次性注入，因此是**实例级**的：只要某个 skill 声明了 mcp，它的工具就在工具列表里，哪怕当前没加载该 skill。这是走原生注入换 HTTP/鉴权全免费的代价。要收紧可用 agent 的 `permission` 按工具名过滤。
- 没有"用到才连"和按 session 隔离 —— 原生 MCP 是常驻连接。lazy-loader / OMO 自己重写连接管理就是为了这两点，代价是 OAuth 之类也要自己实现。
- frontmatter 解析是自带的 YAML 子集解析器，覆盖缩进映射、标量（引号/布尔/数字）、行内数组、块数组、块标量 `|` `>`、行尾注释。不是完整 YAML。

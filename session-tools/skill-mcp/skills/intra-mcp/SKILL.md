---
name: intra-mcp
description: 访问内部 MCP 平台上的工具。当用户的要求需要调用内网平台的能力（内部知识库、内部服务、内部数据查询等）时使用本技能。本技能自带一个走 HTTP + header 鉴权的远程 MCP server，地址与密钥来自环境变量。
mcp:
  intra:
    url: ${INTRA_MCP_URL}
    headers:
      Authorization: Bearer ${INTRA_MCP_KEY}
      X-Tenant-Id: ${INTRA_TENANT:-default}
      X-App-Name: $INTRA_APP
      X-Env-Tag: {env:INTRA_ENV_TAG}
      X-Combo: ${INTRA_TENANT:-default}-$INTRA_APP
---

# 内部 MCP 平台

本技能自带一个远程 MCP server，由 SKILL.md 的 `mcp` 字段声明。它走**普通 HTTP + header 鉴权**，不需要 OAuth。

## 前置：导出环境变量

地址和密钥不在 SKILL.md 里硬编码，来自环境变量。启用前导出这五个：

```bash
export INTRA_MCP_URL=https://mcp.internal.example.com/mcp   # 平台地址（带 /mcp 后缀）
export INTRA_MCP_KEY=your-api-key                            # Authorization 里的密钥
export INTRA_TENANT=your-tenant                              # 有默认值 default，可不设
export INTRA_APP=opencode                                    # 应用名
export INTRA_ENV_TAG=prod                                    # 环境标记
```

每个变量对应 frontmatter 里的位置，写法故意各不相同，用来演示四种语法都可用：

| 环境变量 | frontmatter 里的写法 | 语法 |
|---|---|---|
| `INTRA_MCP_URL` | `url: ${INTRA_MCP_URL}` | `${VAR}` |
| `INTRA_MCP_KEY` | `Authorization: Bearer ${INTRA_MCP_KEY}` | `${VAR}` 嵌在文本里 |
| `INTRA_TENANT` | `X-Tenant-Id: ${INTRA_TENANT:-default}` | `${VAR:-默认值}` |
| `INTRA_APP` | `X-App-Name: $INTRA_APP` | `$VAR` 裸写法 |
| `INTRA_ENV_TAG` | `X-Env-Tag: {env:INTRA_ENV_TAG}` | opencode 原生语法 |

还有一行演示「一个值里塞多个变量」：`X-Combo: ${INTRA_TENANT:-default}-$INTRA_APP`。

**这些变量必须在启动 opencode 的进程环境里**（`export` 之后在同一个 shell 里启动，或写进启动脚本 / `~/.bashrc`）。

变量没设时的行为：引用了未设置且无默认值的变量 → 展开成空字符串 + 启动时打一条 warn（同名只提醒一次）。若 `INTRA_MCP_URL` 为空，整个 server 会被跳过，不会留下坏条目。header 空了导致平台 401 时，`opencode mcp list` 会显示 `needs authentication` —— 那只是 opencode 对 401 的统一标签，**不代表要 OAuth**，去查环境变量即可。

验证是否配好：

```bash
opencode mcp list    # 期望看到 intra 显示 connected
```

## MCP 配置里所有 value 都支持环境变量

三种写法等价，可以混用，作用于整个 mcp 配置的**所有 value**（url、header 的值、command、args、environment……）：

| 写法 | 例子 | 说明 |
|---|---|---|
| `$VAR` | `Bearer $INTRA_MCP_KEY` | 裸写法 |
| `${VAR}` | `Bearer ${INTRA_MCP_KEY}` | shell 风格 |
| `${VAR:-默认值}` | `${INTRA_TENANT:-default}` | 带默认值 |
| `{env:VAR}` | `Bearer {env:INTRA_MCP_KEY}` | 与 opencode 原生配置语法一致 |

需要加更多 header（签名、trace id、租户等）直接往 `headers` 里加：

```yaml
mcp:
  intra:
    url: ${INTRA_MCP_URL}
    headers:
      Authorization: Bearer ${INTRA_MCP_KEY}
      X-Tenant-Id: ${INTRA_TENANT:-default}
      X-App-Name: opencode
```

## 可用工具

本技能的所有工具都以 `intra_` 开头（规则：`<server名>_<工具名>`）。平台上有哪些工具，**看当前工具列表里 `intra_*` 的实际条目和描述**，按任务挑最贴合的调用；不要凭猜测编工具名。

**直接调用工具，不要先去查环境**：不要去跑 `env`、`opencode mcp list` 之类的命令确认配置 —— 配置在启动时就已经确定了。工具列表里没有 `intra_*` 就直接告诉用户"技能未生效，请检查环境变量"，然后停下。

## 何时使用

- 用户的问题需要内网平台才有的数据或能力
- 用户明确提到内部知识库 / 内部服务 / 平台名

## 注意事项

- 密钥只放在环境变量里，**不要写进 SKILL.md**（SKILL.md 会进版本库、会进模型上下文）
- 平台返回 401 时先检查 `INTRA_MCP_KEY` 是否在当前进程环境里生效，而不是去跑 `opencode mcp auth`
- 换平台只改 `url` 和 `headers`，不用动插件

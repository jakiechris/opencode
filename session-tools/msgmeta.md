# 会话级参数(msgmeta / x-message-meta)

发消息时带 header `x-message-meta`(JSON 串),参数按 **merge 语义**落到 session 的 metadata;也可以用 `PATCH /session/{id}` 的 body `metadata` 设置同一份数据(两条路最终都写 `session.metadata`)。普通 key 作为会话变量供 skill 脚本读取;另有 3 个特殊 key 会**额外透传到本会话的 LLM 出站请求**(见下)。设一次一直生效,再传更新/新增 key,不删除未提到的 key。

## 设置方式一:发消息时带 header

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H 'x-message-meta: {"thinking":"false","lang":"zh"}' \
  -d '{"parts":[{"type":"text","text":"处理一下"}]}' \
  "http://localhost:4096/session/ses_123/message"
```

header 里的 key 在消息进入 run-loop 前 merge 进 session metadata;仅 message 相关的两个端点会消费它:
`POST /session/{id}/message`、`POST /session/{id}/prompt_async`。其它请求带这个 header 会被忽略。

## 设置方式二:PATCH update 的 metadata

与 header 等价 —— 写入同一个 `session.metadata`,因此同样触发特殊 key 的透传(适用于不想每次带 header、想预置会话参数的服务端场景):

```bash
curl -s -X PATCH -H "Content-Type: application/json" \
  -d '{"metadata":{"lang":"zh","reqId":"abc123","trace-source":"srv-a","trace-userId":"u-9"}}' \
  "http://localhost:4096/session/ses_123"
```

## skill 脚本里获取

`MESSAGE_METADATA` 环境变量是 merge 后的完整 JSON 串,注入到该会话触发执行的所有 shell/skill 子进程(含三个特殊 key,不剔除):

```python
import os, json
meta = json.loads(os.environ.get("MESSAGE_METADATA", "{}"))
print(meta.get("thinking"), meta.get("lang"))
```

```bash
echo "$MESSAGE_METADATA"
```

## 3 个特殊 key:透传到 LLM 出站请求

普通 key 落到 `session.metadata` 就止步(只作会话变量);以下 3 个 key 命中时,**除落 session 外**,每次本会话发起 LLM 出站调用(title 生成、compaction 总结、子任务、主对话,各 provider 无差别)都会先从当前 `session.metadata` 尝试取值,**有则带、没有就不传**,逐 key 独立:

| key | 出站形态 |
| --- | --- |
| `reqId` | 拼到请求 URL 尾部:`.../chat/completions?reqId=<value>` |
| `trace-source` | 独立请求头:`trace-source: <value>` |
| `trace-userId` | 独立请求头:`trace-userId: <value>` |

出站注入能力与 LLM runtime 的关系:

- **默认 ai-sdk runtime**:两个 trace header(`trace-source`、`trace-userId`)生效;`reqId` 的 URL query 在该通道不注入(ai-sdk 语言模型无 per-request query 口)。
- **native runtime**(`@opencode-ai/llm` 通道,服务端设 `OPENCODE_EXPERIMENTAL_NATIVE_LLM=true`):`reqId` 拼进 URL query,**同时**两个 trace header 也带上 —— 三个 key 完整透传。

## 语义

- **merge**:先带 `{"a":1,"b":2,"c":3}`,再带 `{"a":1,"b":9}` → 结果为 `{"a":1,"b":9,"c":3}`;`c` 保留。
- **sticky**:不带 header 发消息不改变已有值,旧值一直生效,直到再次带 header(或 PATCH)更新;因此 `reqId`/trace 若不更新,会持续跟随本会话后续出站请求。
- 环境变量值是合并后的完整 JSON 串,脚本里 `json.loads` 解析。
- header 只对**已有 session 的消息请求**生效(`POST /session/{id}/message`);建会话(`POST /session`)需要另外带 `x-opencode-directory` 指定目录。PATCH 需要在会话已存在时使用。

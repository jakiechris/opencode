# 消息级参数(msgmeta)

发消息时带 header `x-message-meta`(JSON 串),参数按 **merge 语义** 落到 session 的 metadata,skill 脚本通过环境变量 `MESSAGE_METADATA` 读取。设一次一直生效,再传更新/新增 key,不删除未提到的 key。

## 一行 curl

```bash
curl -s -X POST -H "Content-Type: application/json" -H 'x-message-meta: {"thinking":"false","lang":"zh"}' -d '{"parts":[{"type":"text","text":"处理一下"}]}' "http://localhost:4096/session/ses_123/message"
```

## skill 脚本里获取

Python:

```python
import os, json
meta = json.loads(os.environ.get("MESSAGE_METADATA", "{}"))
print(meta.get("thinking"), meta.get("lang"))
```

Shell:

```bash
echo "$MESSAGE_METADATA"
```

## 语义

- **merge**:先带 `{"a":1,"b":2,"c":3}`,再带 `{"a":1,"b":9}` → 结果为 `{"a":1,"b":9,"c":3}`;`c` 保留。
- **sticky**:不带 header 发消息不改变已有值,旧值一直生效,直到再次带 header 更新。
- 环境变量值是合并后的完整 JSON 串,脚本里 `json.loads` 解析。
- 只对**已有 session 的消息请求**生效(`POST /session/{id}/message`);建会话(`POST /session`)需要另外带 `x-opencode-directory` 指定目录。

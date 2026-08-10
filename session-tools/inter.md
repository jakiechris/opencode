# 接口示例(inter)

serve 跑在本机 **4096**,无鉴权。

## export(整包导出)

```bash
curl -s "http://localhost:4096/session/ses_123/export"
```

返回 `{info, messages}`(该 session 全部消息)。

## export(分包:按 offset 取)

`?offset=N` 从第 N 条开始取,默认一次 1 条;`offset` 超出范围时 `messages` 为 `[]`(= 到底了):

```bash
curl -s "http://localhost:4096/session/ses_123/export?offset=0"
curl -s "http://localhost:4096/session/ses_123/export?offset=1"
```

返回 `{info, messages:[第N条]}`。加 `&limit=100` 一次取 100 条:

```bash
curl -s "http://localhost:4096/session/ses_123/export?offset=0&limit=100"
```

## import(整包,body 直接带 JSON 串)

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{"info":{"id":"ses_123"},"messages":[]}' "http://localhost:4096/session/import"
```

## import(分包:带 offset,顺序校验)

body 加 `offset`(该条消息在 messages 中的下标)。**`offset` 必须等于该 session 当前已入库消息数**,否则返回 400 报错、不落库;`offset=0` 时顺带创建 session:

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{"info":{"id":"ses_123","projectID":"proj_1","title":"t","time":{}},"messages":[{"info":{...},"parts":[...]}],"offset":0}' "http://localhost:4096/session/import"
```

`info` 用 export 返回的原样带回去即可。

## 获取所有顶级 session id

顶级 session = 没有父 session(`parent_id` 为空)。列表接口加 `roots=true` 过滤:

```bash
curl -s "http://localhost:4096/session?roots=true" | jq -r '.[].id'
```

不加 `roots` 则返回所有 session(含子)。

## 遍历子孙 session id

直接子层:

```bash
curl -s "http://localhost:4096/session/ses_123/children" | jq -r '.[].id'
```

递归全部子孙(父在子前,自包含):

```bash
sid=ses_123
declare -A SEEN=()
IDS=()
collect() {
  local s="$1" c
  [ -n "${SEEN[$s]:-}" ] && return
  SEEN[$s]=1
  IDS+=("$s")
  while IFS= read -r c; do [ -n "$c" ] && collect "$c"; done < <(curl -s "http://localhost:4096/session/$s/children" | jq -r '.[].id')
}
collect "$sid"
printf '%s\n' "${IDS[@]}"
```

配合上面的分包 export,对 `IDS` 里的每个 id 各跑一轮 `export?offset=0,1,2...` 即可整棵子树备份。

## delete(删除一个 session)

```bash
curl -s -X DELETE "http://localhost:4096/session/ses_123"
```

返回 `true` = 删除成功,连同该 session 的消息一起删掉。

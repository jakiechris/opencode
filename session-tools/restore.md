# 用 curl 还原 session

思路:每个 session 的存档就是一个 `{info, messages}` JSON 串,import 直接吃这个串——
**和 export 返回串对称**,不需要文件。

> 说明:`--data-binary @文件` 只是 curl 从文件读 body 的写法,接口本身永远只收 JSON 串。
> 所以内联串、管道、文件三种喂法等价。

顺序无关:每个 session 的 info 自带 `parentID`,import 原样入库,先子后父也能重建层级。

## export 直通 import(最对称)

export 返回串,import 吃串,管道串起来,中间不落盘:

```bash
curl -s "http://localhost:4096/session/ses_123/export" | curl -s -X POST -H "Content-Type: application/json" --data-binary @- "http://localhost:4096/session/import"
```

`@-` 表示从标准输入读 body,大 session 也不会有参数长度问题。

## 直接传 JSON 串

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{"info":{"id":"ses_123",...},"messages":[...]}' "http://localhost:4096/session/import"
```

## 从文件夹还原(文件形式,等价)

backup.md 产出的 `ses_123/` 里每个文件就是一个 `{info,messages}`,逐个喂:

```bash
for f in ses_123/*.json; do curl -s -X POST -H "Content-Type: application/json" --data-binary @$f "http://localhost:4096/session/import"; echo; done
```

每个返回 200 + 该 session 的元信息 JSON = 该条还原成功。
已存在的 session id 会原地更新(upsert),重复跑不会产生重复数据。

## 验证

```bash
curl -s "http://localhost:4096/session/ses_123"
curl -s "http://localhost:4096/session/ses_456"        # 子 session,确认还在
```

返回 200 + JSON = 还原成功;404 = 没还上(看上面的报错输出)。

## 常见问题

- **`HTTP 404 POST .../session/import`** → serve 版本太老,没有 `/session/import` 接口,升级或重新编译。
- **返回 400** → body 结构不对,确认是 `{info, messages}` 且 info 里有合法 session id。

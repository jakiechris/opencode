# 用 curl 备份 session(顶级 + 全部子孙)

思路:
1. **遍历**以 `ses_123` 为根的 session id 树(`/children` 递归)
2. **建文件夹** `ses_123/`
3. **每个 session export 一次**,成一个文件 `ses_123/<session_id>.json`

前置条件:serve 跑在本机 **4096**,装了 `curl` 和 `jq`。

## 第 1 步:遍历出所有 session id

看直接子层:

```bash
curl -s "http://localhost:4096/session/ses_123/children" | jq -r '.[].id'
```

有子就再对每个子查它的 children,递归到底。完整遍历见下面合并版。

## 第 2 步:建文件夹,逐个 export

```bash
mkdir -p ses_123
curl -s "http://localhost:4096/session/ses_123/export" -o ses_123/ses_123.json
```

`/export` 一次返回该 session 的全部 `{info, messages}`,不用分页。
对树里每个 session 都执行一次即可。

## 合并版(直接粘贴跑)

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
mkdir -p "$sid"
for s in "${IDS[@]}"; do
  curl -s "http://localhost:4096/session/$s/export" -o "$sid/$s.json"
done
echo "已导出 ${#IDS[@]} 个 session -> $sid/"
```

产物:

```
ses_123/
├── ses_123.json        # 顶级 session
├── ses_456.json        # 子 session
└── ses_789.json        # 孙 session
```

每个文件都是该 session 的 `{info, messages}`,info 里自带 `parentID`,层级信息没丢。

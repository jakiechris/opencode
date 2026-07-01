import { tool } from "@opencode-ai/plugin"
import path from "path"
import os from "os"

function dbPath() {
  const data = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "opencode")
    : path.join(os.homedir(), ".local", "share", "opencode")
  if (process.env.OPENCODE_DISABLE_CHANNEL_DB === "true" || process.env.OPENCODE_DISABLE_CHANNEL_DB === "1") {
    return path.join(data, "opencode.db")
  }
  return path.join(data, "channel.db")
}

export default {
  id: "mytrip-plugin",
  server: async () => {
    const { Database } = await import("bun:sqlite")
    const dbPathResolved = dbPath()
    console.log(`[mytrip-plugin] plugin loaded, db: ${dbPathResolved}`)
    const db = new Database(dbPathResolved, { readonly: true })

    return {
      "experimental.chat.messages.transform": async () => {
        console.log("[mytrip-plugin] experimental.chat.messages.transform hook triggered")
      },
      tool: {
        mytrip: tool({
          description: "移除字符串中的标点符号、空格和回车",
          args: {
            input: tool.schema.string().describe("要处理的字符串"),
          },
          async execute(args) {
            console.log(`[mytrip-plugin] mytrip tool invoked: input = "${args.input}" (len=${args.input.length})`)
            const result = args.input.replace(/[\p{P}\s]/gu, "")
            console.log(`[mytrip-plugin] mytrip tool done: result len=${result.length}`)
            return {
              title: "mytrip 结果",
              output: result,
            }
          },
        }),

        "read-context": tool({
          description: "从数据库读取主agent会话的消息历史，从最近第limit条user消息开始向后返回全部消息",
          args: {
            limit: tool.schema.number().optional().describe("最近第几条user消息（1=最近一条user消息及之后所有消息，2=倒数第二条user消息及之后，以此类推，默认1）"),
          },
          async execute(args, ctx) {
            console.log(`[mytrip-plugin] read-context tool invoked for session ${ctx.sessionID}, limit=${args.limit}`)

            const row = db.prepare("SELECT parent_id FROM session WHERE id = ?").get(ctx.sessionID) as { parent_id: string } | undefined
            const parentID = row?.parent_id ?? ctx.sessionID
            console.log(`[mytrip-plugin] read-context: parent session = ${parentID}`)

            const userIdx = (args.limit ?? 1) - 1
            const userMsg = db.prepare(
              "SELECT time_created FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY time_created DESC LIMIT 1 OFFSET ?",
            ).get(parentID, userIdx) as { time_created: number } | undefined

            if (!userMsg) {
              console.log(`[mytrip-plugin] read-context: no user message found at offset ${userIdx}`)
              return { title: "读取上下文完成", output: "（未找到对应user消息）" }
            }

            console.log(`[mytrip-plugin] read-context: anchor user message time_created=${userMsg.time_created}`)
            const msgs = db.prepare(
              "SELECT id, data FROM message WHERE session_id = ? AND time_created >= ? ORDER BY time_created ASC",
            ).all(parentID, userMsg.time_created) as Array<{ id: string; data: string }>

            console.log(`[mytrip-plugin] read-context: found ${msgs.length} messages, querying parts`)

            const partStmt = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC")
            const lines: string[] = []
            for (const m of msgs) {
              let parsed: Record<string, unknown>
              try { parsed = JSON.parse(m.data) } catch { continue }
              const role = (parsed.role as string) ?? "?"
              const parts = partStmt.all(m.id) as Array<{ data: string }>
              const texts = parts
                .map((p) => {
                  try {
                    const pd = JSON.parse(p.data) as Record<string, unknown>
                    const type = pd.type as string
                    if (type === "text" || type === "reasoning") return pd.text as string
                    if (type === "tool") {
                      const state = pd.state as Record<string, unknown> | undefined
                      const toolName = pd.tool as string
                      if (!state) return `[tool:${toolName}]`
                      const status = state.status as string
                      if (status === "completed" || status === "error") {
                        const output = state.output ?? state.error ?? ""
                        return `[tool:${toolName} ${status}] ${output}`
                      }
                      return `[tool:${toolName} ${status}]`
                    }
                    return ""
                  } catch { return "" }
                })
                .filter(Boolean)
              lines.push(`[${role}]: ${texts.join("\n")}`)
            }

            const contextText = lines.join("\n\n")
            console.log(`[mytrip-plugin] read-context: context length = ${contextText.length} chars`)

            return {
              title: "读取上下文完成",
              output: contextText || "（该会话无消息）",
            }
          },
        }),
      },
    }
  },
}

// 最小 MCP streamable-HTTP server：只认 Authorization: Bearer $EXPECT_KEY，否则 401
// 会把收到的所有 header 打出来，用来证明 header 真的按配置送到了
const EXPECT = process.env.EXPECT_KEY ?? "s3cr3t"
const PORT = Number(process.env.PORT ?? 8801)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const headers: Record<string, string> = {}
    for (const [k, v] of req.headers) headers[k] = v
    const auth = req.headers.get("authorization")

    if (auth !== `Bearer ${EXPECT}`) {
      console.log(`[hdrmcp] REJECT auth=${JSON.stringify(auth)}`)
      return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } }, 401)
    }
    if (req.method !== "POST") return new Response(null, { status: 405 })
    const body: any = await req.json().catch(() => null)
    const method = body?.method

    // 只打印客户端自定义的 header（去掉标准头），便于核对每个环境变量
    const custom = Object.fromEntries(
      Object.entries(headers).filter(([k]) => k.startsWith("x-") || k === "authorization"),
    )
    console.log(`[hdrmcp] ACCEPT ${method} :: ${JSON.stringify(custom)}`)

    if (method === "initialize")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "hdrmcp", version: "1.0.0" },
        },
      })
    if (method === "notifications/initialized") return new Response(null, { status: 202 })
    if (method === "tools/list")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "show_headers",
              description: "回显服务端收到的自定义 header，用来证明 header 配置真的生效",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      })
    if (method === "tools/call")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: `server received headers: ${JSON.stringify(custom, null, 2)}` }] },
      })
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `method not found: ${method}` } })
  },
})
console.log(`[hdrmcp] listening on http://127.0.0.1:${PORT}/mcp  (expects Authorization: Bearer ${EXPECT})`)

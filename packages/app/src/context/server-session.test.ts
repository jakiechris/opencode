import { describe, expect, test } from "bun:test"
import type { Message, OpencodeClient, Session } from "@opencode-ai/sdk/v2/client"
import { createServerSession } from "./server-session"

const session = (id: string, parentID?: string): Session => ({
  id,
  slug: id,
  projectID: "project",
  directory: "/repo",
  title: id,
  version: "1",
  parentID,
  time: { created: 1, updated: 1 },
})

// Message ids encode a wrapped timestamp, so after the 2026-08-14 id clock wrap
// a message created *later* can carry a *smaller* id than an older one. Ordering
// must follow time.created (messageKey), never the raw id.
const wrappedMessage = (id: string, created: number): Message => ({
  id,
  sessionID: "root",
  role: "assistant",
  time: { created },
  parentID: "parent",
  modelID: "model",
  providerID: "provider",
  mode: "build",
  agent: "agent",
  path: { cwd: "/repo", root: "/repo" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

function setup(sessions: Record<string, Session>) {
  const get: unknown[] = []
  const messages: unknown[] = []
  const client = {
    session: {
      get: async (input: unknown) => {
        get.push(input)
        const id = (input as { sessionID: string }).sessionID
        return { data: sessions[id] }
      },
      messages: async (input: unknown) => {
        messages.push(input)
        return { data: [], response: { headers: new Headers() } }
      },
      diff: async () => ({ data: [] }),
      todo: async () => ({ data: [] }),
    },
  } as unknown as OpencodeClient
  return { get, messages, store: createServerSession(client) }
}

describe("server session", () => {
  test("resolves lineage by session ID without directory", async () => {
    const ctx = setup({ child: session("child", "root"), root: session("root") })

    const result = await ctx.store.lineage.resolve("child")

    expect(result.root.id).toBe("root")
    expect(ctx.get).toEqual([{ sessionID: "child" }, { sessionID: "root" }])
    expect(ctx.store.lineage.peek("child")).toEqual(result)
  })

  test("loads session content through the server client", async () => {
    const ctx = setup({ root: session("root") })

    await ctx.store.sync("root")

    expect(ctx.get).toEqual([{ sessionID: "root" }])
    expect(ctx.messages).toEqual([{ sessionID: "root", limit: 2, before: undefined }])
    expect(ctx.store.data.message.root).toEqual([])
  })

  test("applies events without a directory store", () => {
    const ctx = setup({})
    ctx.store.apply({ type: "session.created", properties: { info: session("root") } })
    ctx.store.apply({ type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } })

    expect(ctx.store.get("root")?.directory).toBe("/repo")
    expect(ctx.store.data.session_working("root")).toBe(true)
  })

  test("preserves pinned session content under server-wide cache pressure", () => {
    const ctx = setup({})
    ctx.store.pin("active")
    ctx.store.optimistic.add({
      sessionID: "active",
      message: {
        id: "message",
        sessionID: "active",
        role: "assistant",
        time: { created: 1 },
        parentID: "parent",
        modelID: "model",
        providerID: "provider",
        mode: "build",
        agent: "agent",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    })

    for (let index = 0; index < 50; index++) {
      ctx.store.apply({
        type: "session.status",
        properties: { sessionID: `session-${index}`, status: { type: "busy" } },
      })
    }

    expect(ctx.store.data.message.active?.map((message) => message.id)).toEqual(["message"])
  })

  test("keeps created order across the id wrap on optimistic add", () => {
    const ctx = setup({ root: session("root") })
    // Pre-wrap message has a large id; post-wrap messages have smaller ids but
    // were created later.
    const older = wrappedMessage("ffffffffffff", 1750000000)
    const newer = wrappedMessage("000000000001", 1770000000)
    const newest = wrappedMessage("000000000000", 1800000000)

    ctx.store.apply({ type: "message.updated", properties: { info: older } })
    ctx.store.apply({ type: "message.updated", properties: { info: newer } })
    expect(ctx.store.data.message.root?.map((message) => message.id)).toEqual([
      "ffffffffffff",
      "000000000001",
    ])

    // Optimistic adds must not re-sort the list by raw id (id-sorting would put
    // the wrapped, newest message first).
    ctx.store.optimistic.add({ sessionID: "root", message: newest, parts: [] })
    expect(ctx.store.data.message.root?.map((message) => message.id)).toEqual([
      "ffffffffffff",
      "000000000001",
      "000000000000",
    ])

    // A confirming message.updated must find the optimistic entry instead of
    // inserting a duplicate.
    ctx.store.apply({ type: "message.updated", properties: { info: newest } })
    expect(ctx.store.data.message.root?.map((message) => message.id)).toEqual([
      "ffffffffffff",
      "000000000001",
      "000000000000",
    ])
  })

  test("keeps created order across the id wrap when prepending history", async () => {
    const older = wrappedMessage("ffffffffffff", 1750000000)
    const newer = wrappedMessage("000000000001", 1770000000)

    const client = {
      session: {
        get: async () => ({ data: session("root") }),
        messages: async (input: { before?: string }) => {
          if (input.before === "cursor") {
            return { data: [{ info: older, parts: [] }], response: { headers: new Headers() } }
          }
          const headers = new Headers()
          headers.set("x-next-cursor", "cursor")
          return { data: [{ info: newer, parts: [] }], response: { headers } }
        },
        diff: async () => ({ data: [] }),
        todo: async () => ({ data: [] }),
      },
    } as unknown as OpencodeClient
    const store = createServerSession(client)

    await store.sync("root")
    expect(store.data.message.root?.map((message) => message.id)).toEqual(["000000000001"])

    // Prepending the older page must merge chronologically, not by raw id.
    await store.history.loadMore("root", 2)
    expect(store.data.message.root?.map((message) => message.id)).toEqual([
      "ffffffffffff",
      "000000000001",
    ])
  })
})

import { Data, Effect, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "./session"
import { SessionID } from "./schema"
import { relative, resolve } from "path"

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

type Db = Database.Interface["db"]

export type ImportSessionInput = {
  /** Session info in the export/import shape (GET /session/:id output). */
  info: unknown
  /** Messages with parts, in the export/import shape (GET /session/:id/messages output). */
  messages: ReadonlyArray<{ info: unknown; parts: readonly unknown[] }>
  projectID: string
  directory: string
  worktree: string
}

/** Incremental import rejected the request because `offset` didn't match the session's message count. */
export class OffsetMismatchError extends Data.TaggedError("OffsetMismatchError")<{
  readonly expected: number
  readonly got: number
}> {}

const toRow = (input: ImportSessionInput) =>
  Session.toRow(
    Schema.decodeUnknownSync(Session.Info)({
      ...(input.info as Record<string, unknown>),
      projectID: input.projectID,
      directory: input.directory,
      path: relative(resolve(input.worktree), input.directory).replaceAll("\\", "/"),
    }) as Session.Info,
  )

const upsertSession = (db: Db, row: ReturnType<typeof toRow>) =>
  db
    .insert(SessionTable)
    .values(row)
    .onConflictDoUpdate({
      target: SessionTable.id,
      set: { project_id: row.project_id, directory: row.directory, path: row.path },
    })
    .run()
    .pipe(Effect.orDie)

const insertMessagesAndParts = (db: Db, sessionID: SessionID, messages: ImportSessionInput["messages"]) =>
  Effect.gen(function* () {
    for (const msg of messages) {
      const msgInfo = decodeMessageInfo(msg.info) as SessionV1.Info
      const { id, sessionID: _sessionID, ...msgData } = msgInfo
      yield* db
        .insert(MessageTable)
        .values({
          id,
          session_id: sessionID,
          time_created: msgInfo.time?.created ?? Date.now(),
          data: msgData as never,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      for (const part of msg.parts) {
        const partInfo = decodePart(part) as SessionV1.Part
        const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
        yield* db
          .insert(PartTable)
          .values({
            id: partId,
            message_id: messageID,
            session_id: sessionID,
            data: partData,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }
    }
  })

/**
 * Restore a session from exported data by inserting the session row, then all
 * message and part rows directly into the business tables.
 *
 * Shared by the `opencode import` CLI command and the HTTP `POST /session/import`
 * endpoint. The session's project binding is overridden to the current project,
 * mirroring CLI behavior: the imported session always lives in the project it is
 * restored into.
 */
export const restoreSessionData = Effect.fn("Session.restoreSessionData")(function* (input: ImportSessionInput) {
  const { db } = yield* Database.Service
  const row = toRow(input)
  yield* upsertSession(db, row)
  yield* db.transaction(() => insertMessagesAndParts(db, row.id, input.messages)).pipe(Effect.orDie)
  return row.id
})

/**
 * Incremental import: `offset` must equal the session's current message count
 * (0 for a fresh session), which guarantees messages land in order. Rejects
 * with OffsetMismatchError otherwise and stores nothing. The session row is
 * only upserted on the first call (offset 0).
 */
export const importMessagesAt = Effect.fn("Session.importMessagesAt")(function* (input: ImportSessionInput & {
  offset: number
}) {
  const { db } = yield* Database.Service
  const row = toRow(input)
  const existing = yield* db
    .select({ n: sql<number>`count(*)` })
    .from(MessageTable)
    .where(eq(MessageTable.session_id, row.id))
    .get()
    .pipe(Effect.orDie)
  const expected = existing?.n ?? 0
  if (input.offset !== expected) {
    return yield* new OffsetMismatchError({ expected, got: input.offset })
  }
  if (input.offset === 0) yield* upsertSession(db, row)
  yield* db.transaction(() => insertMessagesAndParts(db, row.id, input.messages)).pipe(Effect.orDie)
  return row.id
})

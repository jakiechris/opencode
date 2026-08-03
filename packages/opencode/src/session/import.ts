import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "./session"
import { relative, resolve } from "path"

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

export type ImportSessionInput = {
  /** Session info in the export/import shape (GET /session/:id output). */
  info: unknown
  /** Messages with parts, in the export/import shape (GET /session/:id/messages output). */
  messages: ReadonlyArray<{ info: unknown; parts: readonly unknown[] }>
  projectID: string
  directory: string
  worktree: string
}

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

  const info = Schema.decodeUnknownSync(Session.Info)({
    ...(input.info as Record<string, unknown>),
    projectID: input.projectID,
    directory: input.directory,
    path: relative(resolve(input.worktree), input.directory).replaceAll("\\", "/"),
  }) as Session.Info
  const row = Session.toRow(info)
  yield* db
    .insert(SessionTable)
    .values(row)
    .onConflictDoUpdate({
      target: SessionTable.id,
      set: { project_id: row.project_id, directory: row.directory, path: row.path },
    })
    .run()
    .pipe(Effect.orDie)

  for (const msg of input.messages) {
    const msgInfo = decodeMessageInfo(msg.info) as SessionV1.Info
    const { id, sessionID: _sessionID, ...msgData } = msgInfo
    yield* db
      .insert(MessageTable)
      .values({
        id,
        session_id: row.id,
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
          session_id: row.id,
          data: partData,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
  }

  return row.id
})

export * as SessionImport from "./import"

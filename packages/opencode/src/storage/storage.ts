import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Exit, Layer, Option, RcMap, Schema, Context, TxReentrantLock } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"

type Migration = (dir: string, fs: FSUtil.Interface) => Effect.Effect<void, FSUtil.Error>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("NotFoundError", {
  message: Schema.String,
}) {
  static isInstance(input: unknown): input is NotFoundError {
    return input instanceof NotFoundError
  }
}

export type Error = FSUtil.Error | NotFoundError

const RootFile = Schema.Struct({
  path: Schema.optional(
    Schema.Struct({
      root: Schema.optional(Schema.String),
    }),
  ),
})

const SessionFile = Schema.Struct({
  id: Schema.String,
})

const MessageFile = Schema.Struct({
  id: Schema.String,
})

const DiffFile = Schema.Struct({
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
})

const SummaryFile = Schema.Struct({
  id: Schema.String,
  projectID: Schema.String,
  summary: Schema.Struct({ diffs: Schema.Array(DiffFile) }),
})

const decodeRoot = Schema.decodeUnknownOption(RootFile)
const decodeSession = Schema.decodeUnknownOption(SessionFile)
const decodeMessage = Schema.decodeUnknownOption(MessageFile)
const decodeSummary = Schema.decodeUnknownOption(SummaryFile)

export interface Interface {
  readonly remove: (key: string[]) => Effect.Effect<void, FSUtil.Error>
  readonly read: <T>(key: string[]) => Effect.Effect<T, Error>
  readonly update: <T>(key: string[], fn: (draft: T) => void) => Effect.Effect<T, Error>
  readonly write: <T>(key: string[], content: T) => Effect.Effect<void, FSUtil.Error>
  readonly list: (prefix: string[]) => Effect.Effect<string[][], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Storage") {}

function file(dir: string, key: string[]) {
  return path.join(dir, ...key) + ".json"
}

function missing(err: unknown) {
  if (!err || typeof err !== "object") return false
  if ("code" in err && err.code === "ENOENT") return true
  if ("reason" in err && err.reason && typeof err.reason === "object" && "_tag" in err.reason) {
    return err.reason._tag === "NotFound"
  }
  return false
}

function parseMigration(text: string) {
  const value = Number.parseInt(text, 10)
  return Number.isNaN(value) ? 0 : value
}

const MIGRATIONS: Migration[] = [
  Effect.fn("Storage.migration.2")(function* (dir: string, fs: FSUtil.Interface) {
    for (const item of yield* fs.glob("session/*/*.json", {
      cwd: dir,
      absolute: true,
    })) {
      const raw = yield* fs.readJson(item)
      const session = decodeSummary(raw, { onExcessProperty: "preserve" })
      if (Option.isNone(session)) continue
      const diffs = session.value.summary.diffs
      yield* fs.writeWithDirs(
        path.join(dir, "session_diff", session.value.id + ".json"),
        JSON.stringify(diffs, null, 2),
      )
      yield* fs.writeWithDirs(
        path.join(dir, "session", session.value.projectID, session.value.id + ".json"),
        JSON.stringify(
          {
            ...(raw as Record<string, unknown>),
            summary: {
              additions: diffs.reduce((sum, x) => sum + x.additions, 0),
              deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
            },
          },
          null,
          2,
        ),
      )
    }
  }),
]

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const locks = yield* RcMap.make({
      lookup: () => TxReentrantLock.make(),
      idleTimeToLive: 0,
    })
    const state = yield* Effect.cached(
      Effect.gen(function* () {
        const dir = path.join(Global.Path.data, "storage")
        const marker = path.join(dir, "migration")
        const migration = yield* fs.readFileString(marker).pipe(
          Effect.map(parseMigration),
          Effect.catchIf(missing, () => Effect.succeed(0)),
          Effect.orElseSucceed(() => 0),
        )
        for (let i = migration; i < MIGRATIONS.length; i++) {
          yield* Effect.logInfo("running migration", { index: i })
          const step = MIGRATIONS[i]!
          const exit = yield* Effect.exit(step(dir, fs))
          if (Exit.isFailure(exit)) {
            yield* Effect.logError("failed to run migration", { index: i, cause: exit.cause })
            break
          }
          yield* fs.writeWithDirs(marker, String(i + 1))
        }
        return { dir }
      }),
    )

    const fail = (target: string): Effect.Effect<never, NotFoundError> =>
      Effect.fail(new NotFoundError({ message: `Resource not found: ${target}` }))

    const wrap = <A>(target: string, body: Effect.Effect<A, FSUtil.Error>) =>
      body.pipe(Effect.catchIf(missing, () => fail(target)))

    const writeJson = Effect.fnUntraced(function* (target: string, content: unknown) {
      yield* fs.writeWithDirs(target, JSON.stringify(content, null, 2))
    })

    const withResolved = <A, E>(
      key: string[],
      fn: (target: string, rw: TxReentrantLock.TxReentrantLock) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | FSUtil.Error> =>
      Effect.scoped(
        Effect.gen(function* () {
          const target = file((yield* state).dir, key)
          return yield* fn(target, yield* RcMap.get(locks, target))
        }),
      )

    const remove: Interface["remove"] = Effect.fn("Storage.remove")(function* (key: string[]) {
      yield* withResolved(key, (target, rw) =>
        TxReentrantLock.withWriteLock(rw, fs.remove(target).pipe(Effect.catchIf(missing, () => Effect.void))),
      )
    })

    const read: Interface["read"] = <T>(key: string[]) =>
      Effect.gen(function* () {
        const value = yield* withResolved(key, (target, rw) =>
          TxReentrantLock.withReadLock(rw, wrap(target, fs.readJson(target))),
        )
        return value as T
      })

    const update: Interface["update"] = <T>(key: string[], fn: (draft: T) => void) =>
      Effect.gen(function* () {
        const value = yield* withResolved(key, (target, rw) =>
          TxReentrantLock.withWriteLock(
            rw,
            Effect.gen(function* () {
              const content = yield* wrap(target, fs.readJson(target))
              fn(content as T)
              yield* writeJson(target, content)
              return content
            }),
          ),
        )
        return value as T
      })

    const write: Interface["write"] = (key: string[], content: unknown) =>
      Effect.gen(function* () {
        yield* withResolved(key, (target, rw) => TxReentrantLock.withWriteLock(rw, writeJson(target, content)))
      })

    const list: Interface["list"] = Effect.fn("Storage.list")(function* (prefix: string[]) {
      const dir = (yield* state).dir
      const cwd = path.join(dir, ...prefix)
      const result = yield* fs
        .glob("**/*", {
          cwd,
          include: "file",
        })
        .pipe(Effect.catch(() => Effect.succeed<string[]>([])))
      return result
        .map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)])
        .toSorted((a, b) => a.join("/").localeCompare(b.join("/")))
    })

    return Service.of({
      remove,
      read,
      update,
      write,
      list,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))

export const node = LayerNode.make(layer, [FSUtil.node])

export * as Storage from "./storage"

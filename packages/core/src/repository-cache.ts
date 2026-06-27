import { Context, Effect, Layer, Schema } from "effect"
import type { FSUtil } from "./fs-util"
import type { EffectFlock } from "./util/effect-flock"
import type { Global } from "./global"

export type Result = {
  readonly repository: string
  readonly host: string
  readonly remote: string
  readonly localPath: string
  readonly status: "cached" | "cloned" | "refreshed"
  readonly head?: string
  readonly branch?: string
}

export type EnsureInput = {
  readonly reference: { label: string; remote: string; host: string }
  readonly refresh?: boolean
  readonly branch?: string
}

export class RepositoryCacheUnsupportedError extends Schema.TaggedErrorClass<RepositoryCacheUnsupportedError>()(
  "RepositoryCacheUnsupportedError",
  { message: Schema.String },
) {}

export type Error = RepositoryCacheUnsupportedError

export interface Interface {
  readonly ensure: (_input: EnsureInput) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/RepositoryCache") {}

export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.succeed({
    ensure: Effect.fn("RepositoryCache.ensure")(function* () {
      return yield* new RepositoryCacheUnsupportedError({ message: "Repository cache requires Git, which is not available" })
    }),
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer

export * as RepositoryCache from "./repository-cache"
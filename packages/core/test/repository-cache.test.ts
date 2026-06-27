import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { RepositoryCache } from "@opencode-ai/core/repository-cache"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("RepositoryCache", () => {
  it.live("returns unsupported error because Git is unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const result = yield* (yield* RepositoryCache.Service)
            .ensure({
              reference: { label: "test", remote: "https://github.com/test/repo.git", host: "github.com" },
            })
            .pipe(Effect.flip)
          expect(result).toBeInstanceOf(RepositoryCache.RepositoryCacheUnsupportedError)
        }).pipe(Effect.provide(cacheLayer(tmp.path))),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

function cacheLayer(root: string) {
  const dependencies = Layer.mergeAll(
    Global.layerWith({ state: path.join(root, "state"), repos: path.join(root, "repos") }),
    FSUtil.defaultLayer,
  )
  return RepositoryCache.layer.pipe(Layer.provide(dependencies))
}

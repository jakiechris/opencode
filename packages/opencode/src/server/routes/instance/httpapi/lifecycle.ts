import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { Effect } from "effect"
import { HttpEffect } from "effect/unstable/http"

type MarkedInstance = {
  ctx: InstanceContext
  store: InstanceStore.Interface
  bridge: EffectBridge.Shape
}

const mark = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    return { ctx, store: yield* InstanceStore.Service, bridge: yield* EffectBridge.make() }
  })

export const markInstanceForDisposal = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx)
    // Disposal runs in the pre-response handler: the handler has already
    // produced its response, but it is only sent to the client once the
    // instance has been fully torn down, so the dispose request returns 200
    // synchronously after disposal completes.
    return yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.uninterruptible(marked.bridge.run(marked.store.dispose(marked.ctx))).pipe(
        Effect.catchCause((cause) => Effect.logWarning("instance disposal failed", { cause })),
        Effect.as(response),
      ),
    )
  })

export const markInstanceForReload = (ctx: InstanceContext, next: InstanceStore.LoadInput) =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx)
    return yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.as(Effect.uninterruptible(marked.bridge.run(marked.store.reload(next))), response),
    )
  })

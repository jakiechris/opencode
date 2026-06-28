import { Layer, ManagedRuntime } from "effect"

import { Plugin } from "@/plugin"
import { ShareNext } from "@/share/share-next"
import { Config } from "@/config/config"
import * as Observability from "@opencode-ai/core/observability"
import { memoMap } from "@opencode-ai/core/effect/memo-map"

export const BootstrapLayer = Layer.mergeAll(
  Config.defaultLayer,
  Plugin.defaultLayer,
  ShareNext.defaultLayer,
).pipe(Layer.provide(Observability.layer))

export const BootstrapRuntime = ManagedRuntime.make(BootstrapLayer, { memoMap })

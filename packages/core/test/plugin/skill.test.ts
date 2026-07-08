import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(
  SkillV2.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(SkillDiscovery.defaultLayer),
    Layer.provideMerge(AgentV2.locationLayer),
  ),
)

describe("SkillPlugin.Plugin", () => {
  it.effect("registers no built-in skills by default", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      const list = yield* skill.list()
      const builtin = list.filter((s) => s.name === "customize-opencode")
      expect(builtin).toHaveLength(0)
    }),
  )
})
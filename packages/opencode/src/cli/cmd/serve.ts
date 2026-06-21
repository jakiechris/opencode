import type { Argv } from "yargs"
import type { NetworkOptions } from "../network"

const ts = () => new Date().toISOString().slice(11, 23)

// Module-level imports are deliberately empty at runtime — every dependency
// (Effect, network options, Flag, AppRuntime, the server module) is loaded only
// when `opencode serve` is actually invoked. This keeps `opencode serve` cold
// start independent of unrelated commands (RunCommand, GenerateCommand, …)
// being eagerly loaded by `src/index.ts`.
export const ServeCommand = {
  command: "serve",
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  builder: async <T>(yargs: Argv<T>) => {
    const { withNetworkOptions } = await import("../network")
    return withNetworkOptions(yargs)
  },
  handler: async (args: NetworkOptions & { "--"?: string[] }) => {
    console.log(`[${ts()}] opencode serve entry`)
    const { AppRuntime } = await import("@/effect/app-runtime")
    const { Effect } = await import("effect")
    const { resolveNetworkOptions } = await import("../network")
    const { Flag } = await import("@opencode-ai/core/flag/flag")

    const inner = Effect.fn("Cli.serve")(function* (a: NetworkOptions & { "--"?: string[] }) {
      const { Server } = yield* Effect.promise(() => import("../../server/server"))
      if (!Flag.OPENCODE_SERVER_PASSWORD) {
        console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
      }
      const opts = yield* resolveNetworkOptions(a)
      const server = yield* Effect.promise(() => Server.listen(opts))
      console.log(`[${ts()}] opencode server ready`)
      console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

      yield* Effect.never
    })

    await AppRuntime.runPromise(inner(args))
  },
}
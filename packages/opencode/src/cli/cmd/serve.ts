import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { networkInterfaces } from "node:os"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const t0 = performance.now()
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const t1 = performance.now()
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const t2 = performance.now()
    const server = yield* Effect.promise(() => Server.listen(opts))
    const t3 = performance.now()
    console.log(
      `[Timing] import server: ${(t1 - t0).toFixed(0)}ms, resolve opts: ${(t2 - t1).toFixed(0)}ms, listen: ${(t3 - t2).toFixed(0)}ms`,
    )
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    const localIp = getLocalIp()
    if (localIp) console.log(`Local IP: ${localIp}`)

    yield* Effect.never
  }),
})

function getLocalIp() {
  const interfaces = networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address
    }
  }
  return undefined
}

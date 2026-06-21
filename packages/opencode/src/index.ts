import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import type { Argv } from "yargs"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { EOL } from "os"

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

// Lazily load a CLI command module. yargs 18 awaits async builders and handlers
// (see yargs-factory.js `isPromise(builderResponse)`), so the actual command
// module — including its transitive deps (Effect, heavy services, etc.) — is
// only loaded when the user actually invokes that command.
//
// This keeps `opencode serve` cold start independent of the 20+ other commands
// (run, generate, tui, web, …) being eagerly imported in this entry point.
//
// IMPORTANT: `loader` must be an arrow function with a LITERAL `import()` call —
// e.g. `() => import("./cli/cmd/serve")`. Bun's static analyzer resolves these
// at compile time. Passing a string path like `import(someVariable)` does NOT
// work in Bun compile mode because the path is opaque to the bundler.
type CmdModule = Record<string, { builder?: (y: Argv<unknown>) => Argv<unknown> | Promise<Argv<unknown>>; handler?: (a: unknown) => unknown | Promise<unknown> }>

function lazyCmd(
  command: string | readonly string[],
  describe: string | false | undefined,
  loader: () => Promise<CmdModule>,
  exportName: string,
) {
  let mod: CmdModule | undefined
  const load = () => mod ? Promise.resolve(mod) : loader().then((m) => { mod = m; return m })
  const cmd: any = {
    command,
    describe,
    builder: async <T>(yargs: Argv<T>) => {
      const m = await load()
      const c = m[exportName]
      if (!c.builder) return yargs as unknown as Argv<unknown>
      return c.builder(yargs as Argv<unknown>)
    },
    handler: async (argv: unknown) => {
      const m = await load()
      const c = m[exportName]
      if (!c.handler) return
      return c.handler(argv)
    },
  }
  return cmd
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(lazyCmd("acp", "start ACP (Agent Client Protocol) server", () => import("./cli/cmd/acp"), "AcpCommand"))
  .command(lazyCmd("mcp", "manage MCP (Model Context Protocol) servers", () => import("./cli/cmd/mcp"), "McpCommand"))
  .command(lazyCmd("$0 [project]", "start opencode tui", () => import("./cli/cmd/tui"), "TuiThreadCommand"))
  .command(lazyCmd("attach <url>", "attach to a running opencode server", () => import("./cli/cmd/attach"), "AttachCommand"))
  .command(lazyCmd("run [message..]", "run opencode with a message", () => import("./cli/cmd/run"), "RunCommand"))
  .command(lazyCmd("generate", undefined, () => import("./cli/cmd/generate"), "GenerateCommand"))
  .command(lazyCmd("debug", "debugging and troubleshooting tools", () => import("./cli/cmd/debug"), "DebugCommand"))
  .command(lazyCmd("console", false, () => import("./cli/cmd/account"), "ConsoleCommand"))
  .command(lazyCmd(["providers", "auth"], "manage AI providers and credentials", () => import("./cli/cmd/providers"), "ProvidersCommand"))
  .command(lazyCmd("agent", "manage agents", () => import("./cli/cmd/agent"), "AgentCommand"))
  .command(lazyCmd("upgrade [target]", "upgrade opencode to the latest or a specific version", () => import("./cli/cmd/upgrade"), "UpgradeCommand"))
  .command(lazyCmd("uninstall", "uninstall opencode and remove all related files", () => import("./cli/cmd/uninstall"), "UninstallCommand"))
  .command(lazyCmd("serve", "starts a headless opencode server", () => import("./cli/cmd/serve"), "ServeCommand"))
  .command(lazyCmd("web", "start opencode server and open web interface", () => import("./cli/cmd/web"), "WebCommand"))
  .command(lazyCmd("models [provider]", "list all available models", () => import("./cli/cmd/models"), "ModelsCommand"))
  .command(lazyCmd("stats", "show token usage and cost statistics", () => import("./cli/cmd/stats"), "StatsCommand"))
  .command(lazyCmd("export [sessionID]", "export session data as JSON", () => import("./cli/cmd/export"), "ExportCommand"))
  .command(lazyCmd("import <file>", "import session data from JSON file or URL", () => import("./cli/cmd/import"), "ImportCommand"))
  .command(lazyCmd("github", "manage GitHub agent", () => import("./cli/cmd/github"), "GithubCommand"))
  .command(lazyCmd("pr <number>", "fetch and checkout a GitHub PR branch, then run opencode", () => import("./cli/cmd/pr"), "PrCommand"))
  .command(lazyCmd("session", "manage sessions", () => import("./cli/cmd/session"), "SessionCommand"))
  .command(lazyCmd(["plugin <module>", "plug"], "install plugin and update config", () => import("./cli/cmd/plug"), "PluginCommand"))
  .command(lazyCmd("db", "database tools", () => import("./cli/cmd/db"), "DbCommand"))
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}

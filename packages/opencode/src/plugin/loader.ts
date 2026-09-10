import {
  checkPluginCompatibility,
  createPluginEntry,
  isDeprecatedPlugin,
  pluginSource,
  resolvePluginTarget,
  type PluginKind,
  type PluginPackage,
  type PluginSource,
} from "./shared"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { join, dirname, basename, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

// Cache for @opencode-ai/plugin package resolution info
let pluginPackageInfo: { exportsMap: Record<string, string>; pkgRoot: string } | null | undefined = undefined

function getPluginPackageInfo() {
  if (pluginPackageInfo !== undefined) return pluginPackageInfo
  if (typeof Bun === "undefined") {
    pluginPackageInfo = null
    return null
  }
  try {
    const resolved = Bun.resolveSync("@opencode-ai/plugin", "/usr/lib/node_modules")
    const resolvedPath = resolved.startsWith("file://") ? fileURLToPath(resolved) : resolved
    const pkgRoot = resolvedPath.replace(/\/dist\/.*$/, "").replace(/\/src\/.*$/, "")
    const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8"))
    const exportsMap: Record<string, string> = {}
    for (const [key, value] of Object.entries(pkgJson.exports || {})) {
      if (typeof value === "string") {
        exportsMap[key] = join(pkgRoot, value)
      } else if (value && typeof value === "object" && "import" in value) {
        exportsMap[key] = join(pkgRoot, (value as any).import)
      }
    }
    pluginPackageInfo = { exportsMap, pkgRoot }
  } catch {
    pluginPackageInfo = null
  }
  return pluginPackageInfo
}

function transformPluginImports(content: string, exportsMap: Record<string, string>): string {
  return content.replace(
    /from\s+["']@opencode-ai\/plugin(\/[^"']*)?["']/g,
    (match, subpath: string | undefined) => {
      const key = subpath ? "." + subpath : "."
      const mapped = exportsMap[key]
      if (mapped) return `from "${mapped}"`
      return match
    }
  )
}

// Resolve relative imports ("./foo", "../bar") to absolute file:// URLs so the file
// can be safely moved to a temp directory (e.g. /tmp) without breaking resolution.
function resolveRelativeImports(content: string, fileDir: string): string {
  // from "./foo", export * from "./foo", export { x } from "./foo"
  content = content.replace(
    /(from\s+["'])(\.[^"']*)(["'])/g,
    (_match, prefix, importPath: string, suffix) => {
      const resolved = resolve(fileDir, importPath)
      return `${prefix}${pathToFileURL(resolved).href}${suffix}`
    }
  )
  // import("./foo")
  content = content.replace(
    /(import\s*\(\s*["'])(\.[^"']*)(["']\s*\))/g,
    (_match, prefix, importPath: string, suffix) => {
      const resolved = resolve(fileDir, importPath)
      return `${prefix}${pathToFileURL(resolved).href}${suffix}`
    }
  )
  // import "./foo" (bare side-effect import at start of line)
  content = content.replace(
    /^(import\s+["'])(\.[^"']*)(["'])/gm,
    (_match, prefix, importPath: string, suffix) => {
      const resolved = resolve(fileDir, importPath)
      return `${prefix}${pathToFileURL(resolved).href}${suffix}`
    }
  )
  return content
}

// Convert ESM JavaScript to CJS for in-memory evaluation via new Function().
// This avoids writing transformed plugin files to disk.
function esmToCjs(code: string): string {
  const namedExports: string[] = []

  // export const|let|var name → keep local variable, register for module.exports
  code = code.replace(/^export\s+(const|let|var)\s+(\w+)/gm, (_match, kw, name) => {
    namedExports.push(name)
    return `${kw} ${name}`
  })
  // export function name → keep local function
  code = code.replace(/^export\s+function\s+(\w+)/gm, (_match, name) => {
    namedExports.push(name)
    return `function ${name}`
  })
  // export class Name → keep local class
  code = code.replace(/^export\s+class\s+(\w+)/gm, (_match, name) => {
    namedExports.push(name)
    return `class ${name}`
  })
  // import { x } from "y" / import { x as z } from "y"
  code = code.replace(/import\s*\{([^}]+)\}\s*from\s+"([^"]+)"/g, (_match, exports, source) => {
    const items = exports.split(",").map((i: string) => i.trim())
    const bindings = items.map((item: string) => {
      const parts = item.split(/\s+as\s+/)
      return parts.length > 1 ? `${parts[0].trim()}: ${parts[1].trim()}` : item
    })
    return `const { ${bindings.join(", ")} } = require("${source}")`
  })
  // import * as x from "y"
  code = code.replace(/import\s*\*\s*as\s+(\w+)\s+from\s+"([^"]+)"/g, (_match, name, source) => `const ${name} = require("${source}")`)
  // import x from "y"
  code = code.replace(/import\s+(\w+)\s+from\s+"([^"]+)"/g, (_match, name, source) => `const ${name} = require("${source}").default ?? require("${source}")`)
  // import "y" (side-effect, no space after import allowed)
  code = code.replace(/^import\s*"([^"]+)"\s*;?\s*$/gm, (_match, source) => `require("${source}");`)
  // export default
  code = code.replace(/^export\s+default\s+/gm, "module.exports.default = ")
  // export { x } / export { x as z }
  code = code.replace(/^export\s+\{([^}]+)\}\s*;?\s*$/gm, (_match, exports) => {
    return exports.split(",").map((i: string) => i.trim()).map((item: string) => {
      const parts = item.split(/\s+as\s+/)
      return `module.exports.${parts.length > 1 ? parts[1].trim() : parts[0].trim()} = ${parts[0].trim()};`
    }).join("\n")
  })
  // export * from "y"
  code = code.replace(/^export\s+\*\s+from\s+"([^"]+)"\s*;?\s*$/gm, (_match, source) =>
    `Object.assign(module.exports, require("${source}"));`)
  // export { x } from "y"
  code = code.replace(/^export\s+\{([^}]+)\}\s+from\s+"([^"]+)"\s*;?\s*$/gm, (_match, exports, source) => {
    const names = exports.split(",").map((i: string) => i.split(/\s+as\s+/)[0].trim())
    return `const { ${names.join(", ")} } = require("${source}")`
  })

  // import.meta is illegal in the CJS/new Function() context this code is evaluated in, but the
  // wrapper in load() already injects __filename/__dirname, so mirror the standard ESM fields.
  if (code.includes("import.meta")) {
    code =
      `const __importMeta = { url: require("url").pathToFileURL(__filename).href, filename: __filename, dirname: __dirname };\n` +
      code.replace(/\bimport\.meta\b/g, "__importMeta")
  }

  // Append module.exports assignments for all named exports
  for (const name of namedExports) {
    code += `\nmodule.exports.${name} = ${name};`
  }
  return code
}

export namespace PluginLoader {
  // A normalized plugin declaration derived from config before any filesystem or npm work happens.
  export type Plan = {
    spec: string
    options: ConfigPluginV1.Options | undefined
    deprecated: boolean
  }

  // A plugin that has been resolved to a concrete target and entrypoint on disk.
  export type Resolved = Plan & {
    source: PluginSource
    target: string
    entry: string
    pkg?: PluginPackage
  }

  // A plugin target we could inspect, but which does not expose the requested kind of entrypoint.
  export type Missing = Plan & {
    source: PluginSource
    target: string
    pkg?: PluginPackage
    message: string
  }

  // A resolved plugin whose module has been imported successfully.
  export type Loaded = Resolved & {
    mod: Record<string, unknown>
  }

  type Candidate = { origin: ConfigPlugin.Origin; plan: Plan }
  type Report = {
    // Called before each attempt so callers can log initial load attempts and retries uniformly.
    start?: (candidate: Candidate, retry: boolean) => void
    // Called when the package exists but does not provide the requested entrypoint.
    missing?: (candidate: Candidate, retry: boolean, message: string, resolved: Missing) => void
    // Called for operational failures such as install, compatibility, or dynamic import errors.
    error?: (
      candidate: Candidate,
      retry: boolean,
      stage: "install" | "entry" | "compatibility" | "load",
      error: unknown,
      resolved?: Resolved,
    ) => void
  }

  type AttemptResult<R> = {
    value?: R
    retry: boolean
  }

  function errorMessage(error: unknown) {
    if (!error || typeof error !== "object") return ""
    const message = "message" in error && typeof error.message === "string" ? error.message : ""
    return message
  }

  function isRetryableResolveError(stage: "install" | "entry" | "compatibility", error: unknown) {
    if (stage !== "install") return false
    return errorMessage(error).includes("missing package.json or index file")
  }

  // Normalize a config item into the loader's internal representation.
  function plan(item: ConfigPluginV1.Spec): Plan {
    const spec = ConfigPlugin.pluginSpecifier(item)
    return { spec, options: ConfigPlugin.pluginOptions(item), deprecated: isDeprecatedPlugin(spec) }
  }

  // Resolve a configured plugin into a concrete entrypoint that can later be imported.
  //
  // The stages here intentionally separate install/target resolution, entrypoint detection,
  // and compatibility checks so callers can report the exact reason a plugin was skipped.
  export async function resolve(
    plan: Plan,
    kind: PluginKind,
  ): Promise<
    | { ok: true; value: Resolved }
    | { ok: false; stage: "missing"; value: Missing }
    | { ok: false; stage: "install" | "entry" | "compatibility"; error: unknown }
  > {
    // First make sure the plugin exists locally, installing npm plugins on demand.
    let target = ""
    try {
      target = await resolvePluginTarget(plan.spec)
    } catch (error) {
      return { ok: false, stage: "install", error }
    }
    if (!target) return { ok: false, stage: "install", error: new Error(`Plugin ${plan.spec} target is empty`) }

    // Then inspect the target for the requested server/tui entrypoint.
    let base
    try {
      base = await createPluginEntry(plan.spec, target, kind)
    } catch (error) {
      return { ok: false, stage: "entry", error }
    }
    if (!base.entry)
      return {
        ok: false,
        stage: "missing",
        value: {
          ...plan,
          source: base.source,
          target: base.target,
          pkg: base.pkg,
          message: `Plugin ${plan.spec} does not expose a ${kind} entrypoint`,
        },
      }

    // npm plugins can declare which opencode versions they support; file plugins are treated
    // as local development code and skip this compatibility gate.
    if (base.source === "npm") {
      try {
        await checkPluginCompatibility(base.target, InstallationVersion, base.pkg)
      } catch (error) {
        return { ok: false, stage: "compatibility", error }
      }
    }
    return { ok: true, value: { ...plan, source: base.source, target: base.target, entry: base.entry, pkg: base.pkg } }
  }

  // Import the resolved module only after all earlier validation has succeeded.
  export async function load(row: Resolved): Promise<{ ok: true; value: Loaded } | { ok: false; error: unknown }> {
    let mod
    try {
      // For file-based plugins, transform @opencode-ai/plugin imports to use
      // the resolved path from the system module path (/usr/lib/node_modules),
      // and resolve relative imports to absolute paths so the file can be
      // loaded from a temp directory (the plugins directory may be read-only).
      if (row.entry.startsWith("file://")) {
        const filePath = fileURLToPath(row.entry)
        const content = readFileSync(filePath, "utf-8")
        if (content.includes("@opencode-ai/plugin")) {
          const info = getPluginPackageInfo()
          if (info) {
            const transformed = transformPluginImports(content, info.exportsMap)
            if (transformed !== content) {
              const fileDir = dirname(filePath)
              const resolved = resolveRelativeImports(transformed, fileDir)

              if (typeof Bun !== "undefined" && typeof Bun.Transpiler !== "undefined") {
                // In-memory: transpile TS → JS, convert ESM → CJS, evaluate via Function.
                // No temp file is written — the plugin module is constructed in memory.
                const transpiler = new Bun.Transpiler({ loader: "ts" })
                const jsCode = transpiler.transformSync(resolved)
                const cjsCode = esmToCjs(jsCode)
                const req = createRequire(filePath)
                const m: { exports: Record<string, unknown> } = { exports: {} }
                const fn = new Function("require", "module", "exports", "__dirname", "__filename", cjsCode)
                fn(req, m, m.exports, fileDir, filePath)
                mod = m.exports
              } else {
                // Fallback for non-Bun environments: write temp file and import
                const tmpDirPath = join(tmpdir(), "opencode-plugins")
                mkdirSync(tmpDirPath, { recursive: true })
                const tmpFile = join(tmpDirPath, `.opencode-imports-${basename(filePath)}`)
                writeFileSync(tmpFile, resolved)
                try {
                  mod = await import(pathToFileURL(tmpFile).href)
                } finally {
                  try { unlinkSync(tmpFile) } catch {}
                }
              }
            }
          }
        }
      }
      if (!mod) {
        mod = await import(row.entry)
      }
    } catch (error) {
      return { ok: false, error }
    }
    if (!mod) return { ok: false, error: new Error(`Plugin ${row.spec} module is empty`) }
    return { ok: true, value: { ...row, mod } }
  }

  // Run one candidate through the full pipeline: resolve, optionally surface a missing entry,
  // import the module, and finally let the caller transform the loaded plugin into any result type.
  async function attempt<R>(
    candidate: Candidate,
    kind: PluginKind,
    retry: boolean,
    finish: ((load: Loaded, origin: ConfigPlugin.Origin, retry: boolean) => Promise<R | undefined>) | undefined,
    missing: ((value: Missing, origin: ConfigPlugin.Origin, retry: boolean) => Promise<R | undefined>) | undefined,
    report: Report | undefined,
  ): Promise<AttemptResult<R>> {
    const plan = candidate.plan
    const filePlugin = pluginSource(plan.spec) === "file"

    // Deprecated plugin packages are silently ignored because they are now built in.
    if (plan.deprecated) return { retry: false }

    report?.start?.(candidate, retry)

    const resolved = await resolve(plan, kind)
    if (!resolved.ok) {
      if (resolved.stage === "missing") {
        // Missing entrypoints are handled separately so callers can still inspect package metadata,
        // for example to load theme files from a tui plugin package that has no code entrypoint.
        if (missing) {
          const value = await missing(resolved.value, candidate.origin, retry)
          if (value !== undefined) return { value, retry: false }
        }
        report?.missing?.(candidate, retry, resolved.value.message, resolved.value)
        return { retry: false }
      }
      report?.error?.(candidate, retry, resolved.stage, resolved.error)
      return { retry: filePlugin && isRetryableResolveError(resolved.stage, resolved.error) }
    }

    const loaded = await load(resolved.value)
    if (!loaded.ok) {
      report?.error?.(candidate, retry, "load", loaded.error, resolved.value)
      return { retry: false }
    }

    // The default behavior is to return the successfully loaded plugin as-is, but callers can
    // provide a finisher to adapt the result into a more specific runtime shape.
    if (!finish) return { value: loaded.value as R, retry: false }
    const value = await finish(loaded.value, candidate.origin, retry)
    return { value, retry: false }
  }

  type Input<R> = {
    items: ConfigPlugin.Origin[]
    kind: PluginKind
    wait?: () => Promise<void>
    finish?: (load: Loaded, origin: ConfigPlugin.Origin, retry: boolean) => Promise<R | undefined>
    missing?: (value: Missing, origin: ConfigPlugin.Origin, retry: boolean) => Promise<R | undefined>
    report?: Report
  }

  // Resolve and load all configured plugins in parallel.
  //
  // If `wait` is provided, file-based plugins with retryable pre-import setup failures are retried
  // once after the caller finishes preparing dependencies. Once dynamic import runs, failures are
  // treated as permanent for this process because Bun caches failed module resolution.
  export async function loadExternal<R = Loaded>(input: Input<R>): Promise<R[]> {
    const candidates = input.items.map((origin) => ({ origin, plan: plan(origin.spec) }))
    const list: Array<Promise<AttemptResult<R>>> = []
    for (const candidate of candidates) {
      list.push(attempt(candidate, input.kind, false, input.finish, input.missing, input.report))
    }
    const out = await Promise.all(list)
    if (input.wait) {
      let deps: Promise<void> | undefined
      for (let i = 0; i < candidates.length; i++) {
        const previous = out[i]
        if (previous?.value !== undefined) continue
        if (previous?.retry !== true) continue

        // Only pre-import file plugin setup failures are retried. Bun caches failed dynamic imports,
        // so dependency waiting cannot fix load/build/runtime/shape failures in this process.
        const candidate = candidates[i]
        if (!candidate || pluginSource(candidate.plan.spec) !== "file") continue
        deps ??= input.wait()
        await deps
        out[i] = await attempt(candidate, input.kind, true, input.finish, input.missing, input.report)
      }
    }

    // Drop skipped/failed entries while preserving the successful result order.
    const ready: R[] = []
    for (const item of out) if (item.value !== undefined) ready.push(item.value)
    return ready
  }
}

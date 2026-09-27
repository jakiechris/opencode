/**
 * skill-mcp —— 让 SKILL.md 的 frontmatter 能声明 MCP server
 *
 * 装了本插件后，任意 skill 的 SKILL.md 除了 name / description，还可以写 mcp 字段：
 *
 *   ---
 *   name: my-skill
 *   description: ...
 *   mcp:
 *     # ① 远程 HTTP MCP（公开的，无需鉴权）
 *     docs:
 *       url: https://mcp.example.com/mcp
 *
 *     # ② 远程 HTTP MCP + 自定义 header（最常见：内网 MCP 平台用 header 鉴权）
 *     api:
 *       url: https://mcp.internal.example.com/mcp
 *       headers:
 *         Authorization: Bearer $MCP_API_KEY     # 三种环境变量写法都认，见下
 *         X-Tenant-Id: ${MCP_TENANT}
 *
 *     # ③ 远程 HTTP MCP + OAuth（省略 oauth 就自动走 OAuth 探测）
 *     oauth-api:
 *       url: https://oauth.example.com/mcp/oauth
 *       oauth:
 *         scope: read write
 *         # clientId / clientSecret / callbackPort / redirectUri 都可选
 *         # 不给 clientId 时走动态客户端注册（RFC 7591）
 *
 *     # ④ 本地 stdio MCP（顺带支持）
 *     local-tool:
 *       command: ["npx", "-y", "@some/mcp-server"]
 *       environment:
 *         KEY: ${SOME_KEY}
 *   ---
 *
 * 环境变量
 * --------
 * mcp 配置里**所有 value**都支持环境变量注入（url、headers 的值、command、args、environment 等），
 * 三种写法等价，可混用：
 *
 *   {env:VAR}            与 opencode 原生配置语法一致
 *   ${VAR}               shell 风格
 *   ${VAR:-默认值}        shell 风格 + 默认值
 *   $VAR                 裸写法
 *
 * 引用了未设置的变量会展开成空字符串，并在启动时打一条 warn（同一个变量只提醒一次）。
 *
 * 工作机制
 * --------
 * 本插件**不实现 MCP 协议，也不实现 OAuth**。它只做一件事：扫 skill 目录 → 读 frontmatter
 * → 把 mcp 块转成 opencode 原生的 MCP 配置 → 注入 config.mcp。
 * 连接、传输（streamable HTTP / SSE）、OAuth 授权、token 存储、401 重试全部由 opencode
 * 原生 MCP 层接管（packages/opencode/src/mcp/），所以 HTTP 和 OAuth 是白送的。
 *
 * server 命名
 * -----------
 * 默认用你在 frontmatter 里写的 server 名。若该名字已被占用（你自己的 opencode.json 里
 * 已经定义过，或另一个 skill 先注册了），则退化为 `<skill名>__<server名>`，避免互相覆盖。
 * MCP 工具对模型暴露的名字是 `<server名>_<工具名>`。
 *
 * OAuth 首次授权
 * --------------
 * 首次连接 OAuth server 时 opencode 会触发授权流程（TUI 下会打开浏览器）。也可手动：
 *   opencode mcp auth <server名>
 *
 * 作用域
 * ------
 * server 在实例启动时一次性注册进 config.mcp，因此是**实例级**的：只要某个 skill 声明了
 * mcp，它的工具就会出现在工具列表里，哪怕当前没加载该 skill。这是原生注入的固有代价
 * （换来的是 HTTP + OAuth 全免费）。若要收紧，可用 agent 的 permission 按工具名过滤。
 *
 * 安装
 * ----
 * 单文件，无依赖，无配置。丢进任一本地插件目录即可自动发现并生效：
 *   项目：<项目>/.opencode/plugins/skill-mcp.ts
 *   全局：~/.config/opencode/plugins/skill-mcp.ts
 * （发现规则见 packages/opencode/src/config/plugin.ts 的 {plugin,plugins}/*.{ts,js}）
 */

import { type Plugin } from "@opencode-ai/plugin"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

// ---------------------------------------------------------------------------
// 极简 YAML 子集解析
//
// 只为读 frontmatter 而写，覆盖会出现的写法：缩进映射、标量（含引号/布尔/数字）、
// 行内数组 [a, b]、块数组、块标量 | 和 >、行尾注释。不追求完整 YAML 兼容。
// ---------------------------------------------------------------------------

function indentOf(line: string): number {
  let n = 0
  while (n < line.length && line[n] === " ") n++
  return n
}

function isBlank(line: string): boolean {
  const t = line.trim()
  return t === "" || t.startsWith("#")
}

function stripComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++
        continue
      }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) return line.slice(0, i)
  }
  return line
}

function splitInline(text: string): string[] {
  const out: string[] = []
  let quote: string | null = null
  let cur = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      cur += c
      if (c === quote && text[i - 1] !== "\\") quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    if (c === ",") {
      out.push(cur)
      cur = ""
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter((s) => s !== "")
}

function unquoteKey(raw: string): string {
  const s = raw.trim()
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1)
  }
  return s
}

function parseScalar(raw: string): unknown {
  const s = raw.trim()
  if (s === "") return null
  if (s === "~" || s === "null" || s === "Null" || s === "NULL") return null
  if (s === "true" || s === "True" || s === "TRUE") return true
  if (s === "false" || s === "False" || s === "FALSE") return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d*\.\d+$/.test(s)) return Number(s)
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'")
  if (s.startsWith("[") && s.endsWith("]")) return splitInline(s.slice(1, -1)).map(parseScalar)
  // `{env:VAR}` / `{file:...}` 按字面字符串处理。严格 YAML 会把 `{env:VAR}` 当成流式映射
  // 解析成对象，但用户写它的意图显然是"让上层做变量替换"，所以这里偏离 YAML 一次。
  if (/^\{(?:env|file):[^}]*\}$/.test(s)) return s
  if (s.startsWith("{") && s.endsWith("}")) {
    const obj: Record<string, unknown> = {}
    for (const part of splitInline(s.slice(1, -1))) {
      const idx = part.indexOf(":")
      if (idx < 0) continue
      obj[unquoteKey(part.slice(0, idx))] = parseScalar(part.slice(idx + 1))
    }
    return obj
  }
  return s
}

/** 块标量 `|` / `>`：吃掉所有比父级更深缩进的行 */
function readBlockScalar(lines: string[], start: number, parentIndent: number): [string, number] {
  const collected: string[] = []
  let i = start
  let base = -1
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() !== "" && indentOf(line) <= parentIndent) break
    if (line.trim() !== "") {
      if (base < 0) base = indentOf(line)
      collected.push(line.slice(base))
    } else {
      collected.push("")
    }
    i++
  }
  return [collected.join("\n").replace(/\s+$/, ""), i]
}

/**
 * 解析一个同缩进层级的块。minIndent 是"至少要比父级深"的下界；
 * 实际缩进以该块第一条内容行为准（YAML 允许任意缩进宽度）。
 */
function parseBlock(lines: string[], start: number, minIndent: number): [unknown, number] {
  let i = start
  while (i < lines.length && isBlank(lines[i])) i++
  if (i >= lines.length) return [null, i]
  const indent = indentOf(lines[i])
  if (indent < minIndent) return [null, start]

  // 序列
  if (/^-(\s|$)/.test(lines[i].slice(indent))) {
    const arr: unknown[] = []
    while (i < lines.length) {
      if (isBlank(lines[i])) {
        i++
        continue
      }
      const ind = indentOf(lines[i])
      if (ind < indent) break
      if (ind > indent) {
        i++
        continue
      }
      const body = stripComment(lines[i].slice(ind))
      if (!/^-(\s|$)/.test(body)) break
      const rest = body.slice(1).trim()
      if (rest === "") {
        const [val, next] = parseBlock(lines, i + 1, indent + 1)
        arr.push(val)
        i = next
      } else {
        const pair = rest.match(/^([^:\s][^:]*?)\s*:\s*(.*)$/)
        if (pair && !rest.startsWith('"') && !rest.startsWith("'")) {
          const obj: Record<string, unknown> = {}
          const value = pair[2].trim()
          obj[unquoteKey(pair[1])] = value === "" ? null : parseScalar(value)
          arr.push(obj)
        } else {
          arr.push(parseScalar(rest))
        }
        i++
      }
    }
    return [arr, i]
  }

  // 映射
  const map: Record<string, unknown> = {}
  while (i < lines.length) {
    if (isBlank(lines[i])) {
      i++
      continue
    }
    const ind = indentOf(lines[i])
    if (ind < indent) break
    if (ind > indent) {
      i++
      continue
    }
    const body = stripComment(lines[i].slice(ind))
    const m = body.match(/^([^:\s][^:]*?)\s*:\s*(.*)$/)
    if (!m) {
      i++
      continue
    }
    const key = unquoteKey(m[1])
    const rest = m[2].trim()
    if (rest.startsWith("|") || rest.startsWith(">")) {
      const [text, next] = readBlockScalar(lines, i + 1, indent)
      map[key] = text
      i = next
    } else if (rest === "") {
      const [val, next] = parseBlock(lines, i + 1, indent + 1)
      map[key] = val
      i = next
    } else {
      map[key] = parseScalar(rest)
      i++
    }
  }
  return [map, i]
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/)
  if (!m) return {}
  const [data] = parseBlock(m[1].split(/\r?\n/), 0, 0)
  if (!data || typeof data !== "object" || Array.isArray(data)) return {}
  return data as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 值处理
// ---------------------------------------------------------------------------

const warnedVars = new Set<string>()

function lookup(name: string, fallback: string | undefined, hasFallback: boolean): string {
  const hit = process.env[name]
  if (hit !== undefined) return hit
  if (hasFallback) return fallback ?? ""
  if (!warnedVars.has(name)) {
    warnedVars.add(name)
    console.warn(`[skill-mcp] environment variable "${name}" is not set; expanded to empty string`)
  }
  return ""
}

/**
 * 环境变量展开，递归处理对象和数组。三种写法都认：
 *   {env:VAR}              与 opencode 原生配置一致（packages/opencode/src/config/variable.ts）
 *   ${VAR} / ${VAR:-默认}  shell 风格，可给默认值
 *   $VAR                   裸写法
 * 只展开「值」，不动 key。
 */
function expandEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      // 1) {env:VAR}
      .replace(/\{env:([^}]+)\}/g, (_all, name: string) => lookup(name.trim(), undefined, false))
      // 2) ${VAR} / ${VAR:-默认值}
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_all, name: string, fallback?: string) =>
        lookup(name, fallback, fallback !== undefined),
      )
      // 3) $VAR（排除已被前面吃掉的 ${...}，以及 \$ 转义）
      .replace(/(?<![\\$])\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, name: string) => lookup(name, undefined, false))
  }
  if (Array.isArray(value)) return value.map(expandEnv)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandEnv(v)
    return out
  }
  return value
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null || v === undefined) continue
    out[k] = Array.isArray(v) ? v.map(String).join(",") : String(v)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 把 frontmatter 里的一条 mcp 声明转成 opencode 原生 MCP 配置。
 * 形状见 packages/core/src/v1/config/mcp.ts 的 Local / Remote。
 */
function toMcpConfig(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const src = expandEnv(raw) as Record<string, unknown>

  // 远程：有 url
  if (typeof src.url === "string" && src.url !== "") {
    const out: Record<string, unknown> = { type: "remote", url: src.url, enabled: true }
    const headers = asStringMap(src.headers)
    if (headers) out.headers = headers

    // 省略 oauth → 不写这个字段，让原生层自动探测 OAuth
    if (src.oauth === false) {
      out.oauth = false
    } else if (src.oauth && typeof src.oauth === "object" && !Array.isArray(src.oauth)) {
      const o = src.oauth as Record<string, unknown>
      const oauth: Record<string, unknown> = {}
      if (o.clientId) oauth.clientId = String(o.clientId)
      if (o.clientSecret) oauth.clientSecret = String(o.clientSecret)
      // 原生 schema 的 scope 是字符串；也接受 scopes: [a, b] 数组写法
      if (typeof o.scope === "string") oauth.scope = o.scope
      else if (Array.isArray(o.scopes)) oauth.scope = o.scopes.map(String).join(" ")
      if (o.callbackPort !== undefined && o.callbackPort !== null) {
        const port = Number(o.callbackPort)
        if (Number.isInteger(port)) oauth.callbackPort = port
      }
      if (o.redirectUri) oauth.redirectUri = String(o.redirectUri)
      out.oauth = oauth
    }
    return out
  }

  // 本地：有 command（顺带支持，不是本插件的主用途）
  if (src.command !== undefined) {
    const command = Array.isArray(src.command)
      ? src.command.map(String)
      : [String(src.command), ...(Array.isArray(src.args) ? src.args.map(String) : [])]
    if (command.length === 0 || command[0] === "") return undefined
    const out: Record<string, unknown> = { type: "local", command, enabled: true }
    const environment = asStringMap(src.environment ?? src.env)
    if (environment) out.environment = environment
    return out
  }

  return undefined
}

// ---------------------------------------------------------------------------
// skill 目录扫描
// ---------------------------------------------------------------------------

const SKILL_DIR_NAMES = [".opencode", ".claude", ".agents"]
const GLOBAL_SKILL_DIRS = [
  [".config", "opencode", "skills"],
  [".claude", "skills"],
  [".agents", "skills"],
]
const MAX_DEPTH = 6

/** 递归找 SKILL.md（大小写不敏感），跳过 node_modules / .git */
async function findSkillFiles(root: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > MAX_DEPTH) return out
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      await findSkillFiles(full, depth + 1, out)
    } else if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
      out.push(full)
    }
  }
  return out
}

function skillRoots(directory: string, worktree: string, config: any): string[] {
  const roots = new Set<string>()

  const home = homedir()
  for (const parts of GLOBAL_SKILL_DIRS) roots.add(join(home, ...parts))

  // 项目侧：从当前目录逐级向上到 worktree
  const chain: string[] = []
  let cur = resolve(directory)
  const stop = worktree ? resolve(worktree) : undefined
  for (let n = 0; n < MAX_DEPTH + 2; n++) {
    chain.push(cur)
    if (stop && cur === stop) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  for (const dir of chain) {
    for (const name of SKILL_DIR_NAMES) roots.add(join(dir, name, "skills"))
  }

  // config.skills.paths 里声明的额外目录（原生 skill 加载器也认这些）
  const extra = config?.skills?.paths
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (typeof item !== "string" || item === "") continue
      const expanded = item.startsWith("~/") ? join(homedir(), item.slice(2)) : item
      roots.add(isAbsolute(expanded) ? expanded : resolve(directory, expanded))
    }
  }

  return [...roots]
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

export const SkillMcp: Plugin = async (ctx) => {
  return {
    // config hook 在实例初始化时被调用，早于 MCP 层首次读取配置；
    // Config.get() 返回的是缓存对象本身，所以这里原地改 config.mcp 会生效。
    config: async (config: any) => {
      try {
        const roots = skillRoots(ctx.directory, ctx.worktree, config)
        const mcp: Record<string, unknown> = (config.mcp ??= {})

        const files: string[] = []
        for (const root of roots) await findSkillFiles(root, 0, files)

        let added = 0
        for (const file of files) {
          const text = await readFile(file, "utf8").catch(() => "")
          if (!text) continue

          const data = parseFrontmatter(text)
          const block = data.mcp
          if (!block || typeof block !== "object" || Array.isArray(block)) continue

          const skillName = typeof data.name === "string" && data.name ? data.name : basename(dirname(file))

          for (const [serverName, rawServer] of Object.entries(block as Record<string, unknown>)) {
            const conf = toMcpConfig(rawServer)
            if (!conf) continue

            // 名字被占用（用户自己的配置或另一个 skill）就加 skill 前缀，避免静默覆盖
            let name = serverName
            let renamed = false
            if (mcp[name] !== undefined) {
              name = `${skillName}__${serverName}`
              renamed = true
            }
            if (mcp[name] !== undefined) continue

            mcp[name] = conf
            added++
            console.log(
              `[skill-mcp] ${renamed ? "renamed+registered" : "registered"} "${name}"` +
                `${renamed ? ` (from "${serverName}")` : ""} <- ${file}`,
            )
          }
        }

        if (added > 0) console.log(`[skill-mcp] ${added} MCP server(s) injected from SKILL.md, scanned ${files.length} skill file(s)`)
      } catch (error) {
        // 插件永远不能把 opencode 启动搞挂
        console.error("[skill-mcp] failed:", error)
      }
    },
  }
}

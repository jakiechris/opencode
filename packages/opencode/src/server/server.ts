import "./init-projectors"

import { NodeHttpServer } from "@effect/platform-node"
import { makeHandler, makeUpgradeHandler } from "@effect/platform-node/NodeHttpServer"
import { WebSocketServer } from "ws"
import { ConfigProvider, Context, Duration, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import { MDNS } from "./mdns"
import { HttpApiApp } from "./routes/instance/httpapi/server"
import { disposeMiddleware } from "./routes/instance/httpapi/lifecycle"
import { WebSocketTracker } from "./routes/instance/httpapi/websocket-tracker"
import { PublicApi } from "./routes/instance/httpapi/public"
import { context as httpApiContext } from "./routes/instance/httpapi/context"
import type { CorsOptions } from "./cors"
import { lazy } from "@/util/lazy"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

export type Listener = {
  hostname: string
  port: number
  url: URL
  stop: (close?: boolean) => Promise<void>
}

type ServerApp = {
  fetch(request: Request): Response | Promise<Response>
  request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
}

type ListenOptions = CorsOptions & {
  port: number
  hostname: string
  mdns?: boolean
  mdnsDomain?: string
}
type ListenerState = {
  scope: Scope.Scope
  server: Context.Service.Shape<typeof HttpServer.HttpServer>
  http: ListenerServer
  websockets: WebSocketTracker.Interface
}
type EffectListener = Omit<Listener, "stop"> & {
  stop: (close?: boolean) => Effect.Effect<void>
}

interface ListenerServer {
  readonly closeAll: Effect.Effect<void>
}

class ListenerServerService extends Context.Service<ListenerServerService, ListenerServer>()(
  "@opencode/ListenerServer",
) {}

export const Default = lazy(() => {
  const handler = HttpApiApp.webHandler().handler
  const app: ServerApp = {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input, init) {
      return app.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
  return { app }
})

export async function openapi() {
  return OpenApi.fromApi(PublicApi)
}

export let url: URL

export async function listen(opts: ListenOptions): Promise<Listener> {
  const listener = await Effect.runPromise(listenEffect(opts))
  return {
    hostname: listener.hostname,
    port: listener.port,
    url: listener.url,
    stop: (close?: boolean) => Effect.runPromiseExit(listener.stop(close)).then(() => undefined),
  }
}

const listenEffect: (opts: ListenOptions) => Effect.Effect<EffectListener, unknown> = Effect.fn("Server.listen")(
  function* (opts: ListenOptions) {
    const state = yield* startWithPortFallback(opts)
    const address = yield* tcpAddress(state)
    const listenerUrl = makeURL(opts.hostname, address.port)
    url = listenerUrl

    const unpublishMdns = yield* setupMdns(opts, address.port, state.scope)

    return {
      hostname: opts.hostname,
      port: address.port,
      url: listenerUrl,
      stop: yield* makeStop(state, unpublishMdns),
    }
  },
)

function startWithPortFallback(opts: ListenOptions) {
  if (opts.port !== 0) return startListener(opts, opts.port)
  // Match the legacy listener port-resolution behavior: explicit `0` prefers
  // 4096 first, then any free port.
  return startListener(opts, 4096).pipe(Effect.catch(() => startListener(opts, 0)))
}

function startListener(opts: ListenOptions, port: number) {
  const scope = Scope.makeUnsafe()
  const memoMap = Layer.makeMemoMapUnsafe()

  // Shared layer instances — reference equality matters for memo-map reuse.
  const server = serverLayer({ port, hostname: opts.hostname })
  const wsTracker = WebSocketTracker.layer
  const cfgProvider = ConfigProvider.layer(ConfigProvider.fromEnv())

  // Phase 1: server + websocket + config only — fast (~200ms).
  // The server starts listening with a 503 catch-all handler.
  const phase1Layer = Layer.mergeAll(server, wsTracker).pipe(Layer.provide(cfgProvider))

  // Phase 2: full routes layer. HttpApiApp and disposeMiddleware are statically
  // imported — `server.ts` itself is already lazily loaded by serve.ts, so these
  // imports don't add to serve cold start.
  const phase2Layer = HttpRouter.serve(HttpApiApp.createRoutes(opts), {
    middleware: disposeMiddleware,
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provideMerge(wsTracker),
    Layer.provideMerge(server),
    Layer.provide(cfgProvider),
  )

  return Effect.gen(function* () {
    // === Phase 1: start listening immediately ===
    const phase1Ctx = yield* Layer.buildWithMemoMap(phase1Layer, memoMap, scope).pipe(
      Effect.provide(httpApiContext),
    )

    // === Phase 2: build routes in background ===
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* Layer.buildWithMemoMap(phase2Layer, memoMap, scope).pipe(
          Effect.provide(httpApiContext),
        )
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("Phase 2 route build failed", cause)),
      ),
    )

    const httpServer = Context.get(phase1Ctx, HttpServer.HttpServer)
    const http = Context.get(phase1Ctx, ListenerServerService)
    const websockets = Context.get(phase1Ctx, WebSocketTracker.Service)
    return { scope, server: httpServer, http, websockets } satisfies ListenerState
  }).pipe(
    Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
  )
}

function tcpAddress(state: ListenerState) {
  return Effect.gen(function* () {
    if (state.server.address._tag === "TcpAddress") return state.server.address
    yield* Scope.close(state.scope, Exit.void).pipe(Effect.ignore)
    return yield* Effect.die(new Error(`Unexpected HttpServer address tag: ${state.server.address._tag}`))
  })
}

function makeURL(hostname: string, port: number) {
  const result = new URL("http://localhost")
  result.hostname = hostname
  result.port = String(port)
  return result
}

function setupMdns(opts: ListenOptions, port: number, scope: Scope.Scope) {
  return Effect.gen(function* () {
    const publish =
      opts.mdns && port && opts.hostname !== "127.0.0.1" && opts.hostname !== "localhost" && opts.hostname !== "::1"
    if (publish) {
      const unpublish = yield* Effect.cached(Effect.sync(() => MDNS.unpublish()))
      yield* Effect.sync(() => MDNS.publish(port, opts.mdnsDomain))
      yield* Scope.addFinalizer(scope, unpublish)
      return unpublish
    }
    if (opts.mdns) {
      yield* Effect.logWarning("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }
    return Effect.void
  })
}

function makeStop(state: ListenerState, unpublishMdns: Effect.Effect<void>) {
  return Effect.gen(function* () {
    const forceCloseOnce = yield* Effect.cached(forceClose(state).pipe(Effect.ignore))
    const closeScopeOnce = yield* Effect.cached(Scope.close(state.scope, Exit.void).pipe(Effect.ignore))

    return (close?: boolean) =>
      Effect.gen(function* () {
        yield* unpublishMdns
        if (close) yield* forceCloseOnce
        yield* closeScopeOnce
      })
  })
}

function forceClose(state: ListenerState) {
  return Effect.all([state.http.closeAll, state.websockets.closeAll], { concurrency: "unbounded", discard: true })
}

function serverLayer(opts: { port: number; hostname: string }) {
  const server = createServer()
  const serverRef = { closeStarted: false, forceStop: false }
  const close = server.close.bind(server)
  // Keep shutdown owned by NodeHttpServer, but honor listener.stop(true) by
  // force-closing active HTTP sockets when its finalizer calls server.close().
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Node's overloads don't preserve a monkey-patched method assignment.
  server.close = ((callback?: Parameters<typeof server.close>[0]) => {
    serverRef.closeStarted = true
    const result = close(callback)
    if (serverRef.forceStop) server.closeAllConnections()
    return result
  }) as typeof server.close

  // Phase 1→2 gap: respond 503 until real routes are built and swapped in.
  const handler503: import("node:http").RequestListener = (_req, res) => {
    if (!res.headersSent) {
      res.writeHead(503, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Server starting..." }))
    }
  }
  server.on("request", handler503)

  return Layer.mergeAll(
    // Custom HttpServer that manages the Phase 1 → Phase 2 handler swap.
    // Replaces NodeHttpServer.layer so we can inject the 503 handler and
    // atomically remove it when Phase 2 installs the real request handler.
    Layer.effect(HttpServer.HttpServer)(
      Effect.gen(function* () {
        const scope = yield* Effect.scope

        // --- Shutdown handling (mirrors NodeHttpServer.make) ---
        const shutdown = yield* Effect.callback<Effect.Effect<void>>((resume) => {
          if (!server.listening) return resume(Effect.void)
          server.close((error) => {
            if (error) resume(Effect.die(error))
            else resume(Effect.void)
          })
        }).pipe(Effect.cached)
        const preemptiveShutdown = Effect.timeoutOrElse(shutdown, {
          duration: Duration.seconds(1),
          orElse: () => Effect.void,
        })
        yield* Scope.addFinalizer(scope, shutdown)

        // --- Start listening (Phase 1 — fast, no routes yet) ---
        yield* Effect.callback((resume: (e: Effect.Effect<void>) => void) => {
          function onError(cause: Error) {
            resume(Effect.fail(new Error(`Server listen failed: ${cause.message}`)))
          }
          server.on("error", onError)
          server.listen({ port: opts.port, host: opts.hostname }, () => {
            server.off("error", onError)
            resume(Effect.void)
          })
        })

        const address = server.address()
        // --- WebSocket server ---
        const wss = yield* Effect.acquireRelease(
          Effect.sync(() => new WebSocketServer({ noServer: true })),
          (wss) => Effect.callback((resume) => { wss.close(() => resume(Effect.void)) }),
        ).pipe(Scope.provide(scope), Effect.cached)

        return HttpServer.make({
          address:
            typeof address === "string"
              ? ({ _tag: "UnixAddress" as const, path: address })
              : ({
                  _tag: "TcpAddress" as const,
                  hostname: address.address === "::" ? "0.0.0.0" : address.address,
                  port: address.port,
                }),
          serve: Effect.fnUntraced(function* (httpApp, middleware) {
            // ATOMIC: remove 503 handler before installing the real handler.
            // Both operations happen synchronously in the same microtask, so
            // no request can be processed between them.
            server.off("request", handler503)

            const serveScope = yield* Effect.scope
            const handlerScope = Scope.forkUnsafe(serveScope, "parallel")
            const handler = yield* makeHandler(httpApp, { middleware, scope: handlerScope })
            const upgradeHandler = yield* makeUpgradeHandler(wss, httpApp, { middleware, scope: handlerScope })

            yield* Scope.addFinalizerExit(serveScope, () => {
              server.off("request", handler)
              server.off("upgrade", upgradeHandler)
              return preemptiveShutdown
            })
            server.on("request", handler)
            server.on("upgrade", upgradeHandler)
          }),
        })
      }),
    ),
    NodeHttpServer.layerHttpServices,
    Layer.succeed(ListenerServerService)(
      ListenerServerService.of({
        closeAll: Effect.sync(() => {
          serverRef.forceStop = true
          if (serverRef.closeStarted) server.closeAllConnections()
        }),
      }),
    ),
  )
}

export * as Server from "./server"
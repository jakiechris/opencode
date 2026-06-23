import { Context } from "effect"

// Shared Effect context used across the server to provide ambient
// services during layer construction and request handling.
// Extracted to its own file so `server.ts` can import it without
// triggering the full route/service module graph.
export const context = Context.makeUnsafe<unknown>(new Map())

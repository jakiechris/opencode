import { Effect } from "effect"

interface DisposeEntry {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

// Per-directory dispose signal registry.
// One entry per directory that is either currently running or being disposed.
const registry = new Map<string, DisposeEntry>()

function getOrCreate(directory: string): DisposeEntry {
  let entry = registry.get(directory)
  if (!entry) {
    let resolve!: () => void
    const promise = new Promise<void>((res) => {
      resolve = res
    })
    entry = { promise, resolve }
    registry.set(directory, entry)
  }
  return entry
}

/**
 * Signal that a directory's instance is about to be disposed.
 * All awaitDisposing() callers for this directory unblock immediately.
 * Called by disposeContext BEFORE running disposers.
 */
export function signalDisposing(directory: string): void {
  getOrCreate(directory).resolve()
}

/**
 * Remove the entry after disposal is fully complete.
 * Called by disposeContext AFTER emitDisposed.
 */
export function clearDisposeSignal(directory: string): void {
  registry.delete(directory)
}

/**
 * Returns an Effect that resolves (void) the moment the given directory begins
 * disposing. If the instance was already signalled before this is called, the
 * Effect resolves immediately (Promise already resolved).
 * Safe to use with Effect.race — never rejects.
 */
export function awaitDisposing(directory: string): Effect.Effect<void> {
  return Effect.promise(() => getOrCreate(directory).promise)
}

import { defineConfig } from "vitest/config";

// Vitest config for the Web UI (M2.2).
//
// `environment: "happy-dom"` polyfills the browser-only globals our
// tests touch: `WebSocket`, `Event`, `MessageEvent`, `CloseEvent`.
// We still stub `WebSocket` ourselves (via `vi.stubGlobal`) so the
// fake can drive `open` / `message` / `close` deterministically.

export default defineConfig({
  test: {
    environment: "happy-dom",
    // Component tests (M2.8+) need the `.test.tsx` suffix; the M2.2
    // pure-logic tests use `.test.ts`.
    include: ["src/**/*.test.{ts,tsx}"],
    // Tell react-dom/client that we're inside React's `act()`, so
    // component tests don't get spammed with the "act warning" lines.
    setupFiles: ["./vitest.setup.ts"],
    // Short per-test timeout: pending-call cleanup is verified by
    // the disconnect / close tests. Anything past 5s is a bug.
    testTimeout: 5000,
    // M3.x: cap concurrency to 1 worker — happy-dom leaks a few
    // hundred KB per concurrent React render, and running
    // component-heavy suites in parallel exhausts the worker's
    // heap (8GB default).
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
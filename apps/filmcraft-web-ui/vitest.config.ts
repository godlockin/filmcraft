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
    include: ["src/**/*.test.ts"],
    // Short per-test timeout: pending-call cleanup is verified by
    // the disconnect / close tests. Anything past 5s is a bug.
    testTimeout: 5000,
  },
});
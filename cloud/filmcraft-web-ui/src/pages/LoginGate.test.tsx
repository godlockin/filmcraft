/**
 * Vitest unit tests for `<LoginGate />` (M2.7b).
 *
 * The gate is a thin wrapper around the store's `login` action, so
 * the tests focus on the wiring: typing into the inputs + clicking
 * submit must call `login` with the right values, the error string
 * from the store must render, and the button must disable itself
 * while a request is in flight.
 *
 * `fetch` is stubbed so the test stays synchronous at the React
 * boundary — the store's `login` awaits the response, but we don't
 * need real network here. We restore the stub in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import LoginGate from "./LoginGate";
import { useEngineStore } from "../store";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function renderGate(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<LoginGate />);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function typeInto(host: ParentNode, name: string, value: string): void {
  const input = host.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  act(() => {
    const evt = new Event("change", { bubbles: true });
    Object.defineProperty(input, "value", { value, configurable: true });
    input!.dispatchEvent(evt);
  });
}

function clickSubmit(host: ParentNode): void {
  const button = host.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  act(() => {
    button!.click();
  });
}

describe("LoginGate", () => {
  let host: Harness | null = null;

  beforeEach(() => {
    // Reset the store between tests so `authError` and any fetch mocks
    // from one test don't leak into the next.
    useEngineStore.setState({ auth: null, authError: null });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    host?.unmount();
    host = null;
  });

  it("renders username, password, and submit button", () => {
    host = renderGate();
    const inputs = host.container.querySelectorAll("input");
    expect(inputs).toHaveLength(2);
    expect((inputs[0] as HTMLInputElement).type).toBe("text");
    expect((inputs[1] as HTMLInputElement).type).toBe("password");
    const submit = host.container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit).not.toBeNull();
    expect(submit.disabled).toBe(false);
  });

  it("calls store.login with the typed credentials and renders the error on failure", async () => {
    const loginSpy = vi.spyOn(useEngineStore.getState(), "login");
    // Mock fetch to return an error envelope so the store's `login`
    // sets `authError` instead of succeeding.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: "invalid username or password" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    host = renderGate();
    typeInto(host.container, "username", "admin");
    typeInto(host.container, "password", "wrong");
    await act(async () => {
      clickSubmit(host!.container);
      // Drain the microtask queue so the await fetch / setState
      // chains in the store settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loginSpy).toHaveBeenCalledWith("admin", "wrong");
    expect(useEngineStore.getState().authError).toMatch(/invalid username or password/);
    expect(host.container.querySelector(".error")?.textContent ?? "").toMatch(/invalid username or password/);
  });

  it("disables the submit button while a request is in flight", async () => {
    // A fetch that we resolve manually so we can observe the busy
    // state mid-request rather than racing the assertion.
    let resolveFetch: (resp: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    host = renderGate();
    typeInto(host.container, "username", "admin");
    typeInto(host.container, "password", "123456");
    let submit: HTMLButtonElement;
    await act(async () => {
      clickSubmit(host!.container);
      // Let the store reach the `await fetch(...)` line.
      await Promise.resolve();
      await Promise.resolve();
      submit = host!.container.querySelector('button[type="submit"]') as HTMLButtonElement;
    });
    expect(submit!.disabled).toBe(true);
    expect(submit!.textContent ?? "").toMatch(/Signing in/);
    // Resolve the in-flight fetch so the store settles, the button
    // re-enables, and we don't leak the unresolved promise.
    await act(async () => {
      resolveFetch(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});

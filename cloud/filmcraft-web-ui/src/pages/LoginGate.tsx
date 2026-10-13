/**
 * Inline login gate (M2.7b).
 *
 * Renders a small username + password form. Submits through the
 * store's `login()` action; on success the parent (App.tsx) re-renders
 * with the real router tree; on failure the form stays put and
 * `authError` is shown above the inputs.
 *
 * The submit button is disabled while the request is in flight, and
 * the inputs are uncontrolled-by-prop: local component state drives
 * them, the form clears on success (because we unmount), and the
 * password input is `type="password"` so it's not echoed in screenshots.
 *
 * Out of scope for M2.7b (deferred to M2.11): form validation beyond
 * `required`, focus / keyboard ergonomics, and the visual polish pass.
 */

import { useState, type FormEvent } from "react";
import { useEngineStore } from "../store";

export default function LoginGate() {
  const login = useEngineStore((s) => s.login);
  const authError = useEngineStore((s) => s.authError);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await login(username, password);
      // On success, the store sets `auth` and the parent swaps the gate
      // out for the router tree — no local cleanup needed.
    } catch {
      // `authError` is now set in the store; the form re-renders below
      // the inputs to display it. The catch exists only to swallow the
      // rejection so it doesn't surface as an unhandled promise.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-gate">
      <h2>Sign in</h2>
      <form onSubmit={onSubmit}>
        <label>
          Username
          <input
            type="text"
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            disabled={busy}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            disabled={busy}
          />
        </label>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {authError !== null && <div className="error">{authError}</div>}
    </div>
  );
}

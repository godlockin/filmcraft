/**
 * Logout button (M2.7b).
 *
 * One-liner: calls the store's `logout()` action. The store handles
 * the network call + localStorage cleanup; the parent's re-render
 * swaps back to `<LoginGate />` automatically.
 *
 * `type="button"` so accidental placement inside a `<form>` (e.g. the
 * new-project widget on `ProjectList`) doesn't submit on click.
 */

import { useEngineStore } from "../store";

export default function LogoutButton() {
  const logout = useEngineStore((s) => s.logout);
  return (
    <button type="button" onClick={() => void logout()}>
      Sign out
    </button>
  );
}

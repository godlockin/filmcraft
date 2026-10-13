import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import ProjectList from "./pages/ProjectList";
import ProjectDetail from "./pages/ProjectDetail";
import LoginGate from "./pages/LoginGate";
import { useEngineStore } from "./store";

/**
 * Top-level router for the FilmCraft web UI (M1.7).
 *
 * Two real routes — project list (`/`) and project detail
 * (`/project/:id`) — plus a `<Navigate>` fallback for anything else. The
 * server-side fallback in `filmcraft-server/src/main.rs` already serves
 * `index.html` for arbitrary paths, so a typo'd URL lands here rather
 * than a 404.
 *
 * M2.7b: when the auth slice is `null` (no token in localStorage), we
 * render `<LoginGate />` instead of the real routes. The `hydrateAuth`
 * effect runs on mount so a returning user (whose token is already
 * persisted) gets through the gate without re-typing a password.
 */
export default function App() {
  const auth = useEngineStore((s) => s.auth);
  const hydrateAuth = useEngineStore((s) => s.hydrateAuth);
  useEffect(() => {
    hydrateAuth();
  }, [hydrateAuth]);

  if (auth === null) {
    return (
      <main>
        <LoginGate />
      </main>
    );
  }

  return (
    <>
      <header>
        <h1>FilmCraft</h1>
        <nav>
          <a href="/">Projects</a>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<ProjectList />} />
          <Route path="/project/:id" element={<ProjectDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}

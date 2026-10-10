import { Navigate, Route, Routes } from "react-router-dom";
import ProjectList from "./pages/ProjectList";
import ProjectDetail from "./pages/ProjectDetail";

/**
 * Top-level router for the FilmCraft web UI (M1.7).
 *
 * Two real routes — project list (`/`) and project detail
 * (`/project/:id`) — plus a `<Navigate>` fallback for anything else. The
 * server-side fallback in `filmcraft-server/src/main.rs` already serves
 * `index.html` for arbitrary paths, so a typo'd URL lands here rather
 * than a 404.
 */
export default function App() {
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

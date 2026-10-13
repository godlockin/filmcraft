import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Header from "./components/Header";
import ProjectList from "./pages/ProjectList";
import ProjectDetail from "./pages/ProjectDetail";
import LoginGate from "./pages/LoginGate";
import Dock from "./components/Dock";
import StatusBar from "./components/StatusBar";
import ImportMode from "./components/ImportMode";
import ExportModePanel from "./components/ExportModePanel";
import ProjectDialog from "./lib/projectDialog";
import { useEngineStore } from "./store";
import { buildShortcutMap, registerShortcuts } from "./lib/shortcuts";

/**
 * Top-level router for the FilmCraft web UI.
 *
 * - M1.7: project list (`/`) and project detail (`/project/:id`)
 *   routes plus a `<Navigate>` fallback.
 * - M2.7b: when the auth slice is `null` we render `<LoginGate />`
 *   instead. Hydration in a `useEffect`.
 * - M3.2: persistent dark `<Header />` with Import / Edit / Export
 *   mode tabs.
 * - M3.3: when `activeMode === "edit"` we render the `<Dock />`
 *   shell. `ProjectList` is now a dialog the user opens from the
 *   Header. M3.9 adds a full-screen `<ImportMode />` overlay for
 *   `"import"`. M3.10 will add the `"export"` overlay.
 * - The legacy routes stay mounted on every active mode so a
 *   programmatic navigation (e.g. from the project list card)
 *   works without a route change being visible to the user.
 */
export default function App() {
  const auth = useEngineStore((s) => s.auth);
  const hydrateAuth = useEngineStore((s) => s.hydrateAuth);
  const activeMode = useEngineStore((s) => s.ui.activeMode);
  const commands = useEngineStore((s) => s.commands);
  const runCommand = useEngineStore((s) => s.runCommand);

  const [projectsOpen, setProjectsOpen] = useState(false);

  useEffect(() => {
    hydrateAuth();
  }, [hydrateAuth]);

  // M3.11: register the keyboard-shortcut infrastructure (lib/shortcuts).
  // It looks up matching commands against `engine.commands` and invokes
  // them through the same `runCommand` the CommandPalette uses. The map
  // is rebuilt whenever the engine returns a new command list.
  useEffect(() => {
    if (commands === null) return;
    const map = buildShortcutMap(commands);
    const reg = registerShortcuts(map, (ids) => {
      // Take the first match; per-panel shortcut mapping is out of scope.
      const id = ids[0];
      if (id === undefined) return;
      void runCommand(id);
    });
    return () => reg.dispose();
  }, [commands, runCommand]);

  if (auth === null) {
    return (
      <main style={{ background: "var(--app-bg)", minHeight: "100vh" }}>
        <LoginGate />
      </main>
    );
  }

  return (
    <div
      style={{
        background: "var(--app-bg)",
        color: "var(--text)",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Header onOpenProjects={() => setProjectsOpen(true)} />
      <main
        data-active-mode={activeMode}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {activeMode === "edit" ? (
          <Dock />
        ) : activeMode === "import" ? (
          <ImportMode />
        ) : activeMode === "export" ? (
          <ExportModePanel fullScreen />
        ) : (
          <Routes>
            <Route path="/" element={<ProjectList />} />
            <Route path="/project/:id" element={<ProjectDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
      <ProjectDialog
        open={projectsOpen}
        onClose={() => setProjectsOpen(false)}
      >
        <ProjectList />
      </ProjectDialog>
      {/* Always-mounted project-detail route so direct linking and
          post-creation navigation still works while the dock is
          visible. The detail page itself is empty of body content
          until the dock body is swapped in for it (M3.4+). */}
      <Routes>
        <Route path="/project/:id" element={<ProjectDetail />} />
      </Routes>
      <StatusBar />
    </div>
  );
}

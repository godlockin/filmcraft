import { useCallback, useEffect, useState } from "react";
import ProjectCard from "../components/ProjectCard";
import LogoutButton from "../components/LogoutButton";
import { createProject, deleteProject, listProjects } from "../api";
import type { Project } from "../types";

/**
 * Project listing page (route `/`). Fetches the list of projects for the
 * current (placeholder) user and renders a card per project, plus a
 * "New" widget at the top. The card click navigates to the project
 * detail page; the Delete button on each card calls the server's
 * DELETE endpoint.
 */
export default function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");

  const reload = useCallback(async () => {
    setError(null);
    try {
      const resp = await listProjects();
      setProjects(resp.projects);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleCreate = async () => {
    if (!newId.trim()) return;
    setError(null);
    try {
      await createProject({ id: newId.trim(), name: newName.trim() || undefined });
      setNewId("");
      setNewName("");
      setCreating(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Stable callback so child `ProjectCard`s won't see a new function
  // reference on every render.
  const handleDelete = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await deleteProject(id);
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [reload],
  );

  return (
    <div>
      <h2>Projects</h2>
      <div className="project-list-header">
        <LogoutButton />
      </div>
      {error && <div className="error">{error}</div>}

      {!creating ? (
        <button className="primary" onClick={() => setCreating(true)}>
          + New project
        </button>
      ) : (
        <div className="new-project">
          <input
            type="text"
            placeholder="id (e.g. demo)"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
          />
          <input
            type="text"
            placeholder="name (optional)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button className="primary" onClick={handleCreate} disabled={!newId.trim()}>
            Create
          </button>
          <button onClick={() => setCreating(false)}>Cancel</button>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="empty">No projects yet. Create one above.</div>
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

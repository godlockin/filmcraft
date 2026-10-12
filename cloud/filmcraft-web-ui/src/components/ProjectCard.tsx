import { Link } from "react-router-dom";
import type { Project } from "../types";

/**
 * A single project card on the listing page. Renders `id` and the human
 * name (falling back to `id` when `meta.json` was missing or unreadable).
 *
 * Click anywhere on the card to open it. "Delete" is a separate button so
 * it has to be explicit; we don't want an accidental click to wipe work.
 */
export default function ProjectCard({
  project,
  onDelete,
}: {
  project: Project;
  onDelete: (id: string) => void;
}) {
  const display = project.name ?? project.id;
  return (
    <div className="project-card">
      <Link to={`/project/${project.id}`} style={{ color: "inherit", textDecoration: "none" }}>
        <h3>{display}</h3>
        <div className="meta">
          {project.updatedAt ? `Updated ${new Date(project.updatedAt).toLocaleString()}` : "no edits yet"}
          {project.size !== null ? ` · ${(project.size / 1024).toFixed(1)} KB` : ""}
        </div>
      </Link>
      <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.4rem" }}>
        <button
          className="danger"
          onClick={(e) => {
            e.preventDefault();
            if (confirm(`Delete project "${display}"? This cannot be undone.`)) {
              onDelete(project.id);
            }
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import EngineConsole from "../components/EngineConsole";
import MediaItem from "../components/MediaItem";
import UploadForm from "../components/UploadForm";
import { getExportInfo, listMedia, streamUrl } from "../api";

/**
 * Project-detail page (route `/project/:id`). Shows:
 *   * the project's media grid + upload widget (top);
 *   * a `<video>` player for the user-selected clip (middle);
 *   * an "Export" button at the bottom that opens the export download
 *     the server returned.
 */
export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = id ?? "";

  const [items, setItems] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-fetch the media listing when the route param changes. We
  // deliberately bind only to `projectId` so an in-flight reload from
  // the previous projectId can't overwrite the current one's data.
  useEffect(() => {
    let cancelled = false;
    if (!projectId) return;
    listMedia(projectId)
      .then((resp) => {
        if (cancelled) return;
        setItems(resp.items);
        setSelected((prev) => prev ?? resp.items[0] ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Pre-compute the `MediaItem` array once per (items, projectId).
  // `MediaItem` is memoised inside; without this map each render would
  // pass a new `item` object reference even when nothing had changed.
  const mediaItems = useMemo(
    () => items.map((name) => ({ name, url: streamUrl(projectId, name) })),
    [items, projectId],
  );

  const selectedUrl = useMemo(() => {
    if (!selected) return null;
    return streamUrl(projectId, selected);
  }, [projectId, selected]);

  const handleExport = async () => {
    setError(null);
    try {
      const info = await getExportInfo(projectId);
      window.open(info.download.url, "_blank");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onUploaded = () => {
    listMedia(projectId)
      .then((resp) => setItems(resp.items))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div>
      <div style={{ marginBottom: "0.5rem" }}>
        <Link to="/">← back to projects</Link>
      </div>
      <h2>Project: {projectId}</h2>
      {error && <div className="error">{error}</div>}

      <UploadForm projectId={projectId} onUploaded={onUploaded} />

      <h3 style={{ marginTop: "1.5rem" }}>Media</h3>
      {mediaItems.length === 0 ? (
        <div className="empty">No media uploaded yet.</div>
      ) : (
        <div className="media-grid">
          {mediaItems.map((item) => (
            <MediaItem
              key={item.name}
              item={item}
              selected={selected === item.name}
              onSelect={setSelected}
            />
          ))}
        </div>
      )}

      {selectedUrl && (
        <div className="video-player">
          {/* `key={selectedUrl}` forces React to re-mount the <video>
              when the user picks a different clip (or the auth token
              changes after a re-login), so the browser doesn't reuse
              a previous failed-load state. */}
          <video key={selectedUrl} controls src={selectedUrl} preload="metadata" />
        </div>
      )}

      <div style={{ marginTop: "1.5rem" }}>
        <button onClick={handleExport}>Export</button>
      </div>

      <EngineConsole projectId={projectId} />
    </div>
  );
}

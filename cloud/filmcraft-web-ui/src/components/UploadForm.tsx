import { useRef, useState } from "react";
import { uploadMedia } from "../api";

/**
 * Upload widget for a single media file. Uses XHR rather than `fetch`
 * so `xhr.upload.onprogress` fires during the request — `fetch` only
 * reports progress for streamed response bodies, not the upload itself.
 */
export default function UploadForm({
  projectId,
  onUploaded,
}: {
  projectId: string;
  onUploaded: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setProgress(0);
    setError(null);
    try {
      await uploadMedia(projectId, file, (frac) => setProgress(frac));
      setProgress(null);
      onUploaded();
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    }
  };

  return (
    <div className="upload-form">
      <input
        ref={inputRef}
        type="file"
        accept="video/*,audio/*,image/*"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
        disabled={progress !== null}
      />
      {progress !== null && (
        <>
          <div style={{ marginTop: "0.6rem" }}>Uploading… {Math.round(progress * 100)}%</div>
          <div className="progress">
            <div className="bar" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

import type { MediaItem as MediaItemType } from "../types";

/**
 * Tile in the project's media grid. Renders a tiny muted `<video>`
 * preview so the user can tell at a glance which clip is which; the
 * whole tile is clickable to select it for the player.
 */
export default function MediaItem({
  item,
  selected,
  onSelect,
}: {
  item: MediaItemType;
  selected: boolean;
  onSelect: (name: string) => void;
}) {
  return (
    <div
      className={`media-item${selected ? " selected" : ""}`}
      onClick={() => onSelect(item.name)}
    >
      <video src={item.url} muted preload="metadata" />
      <div className="label">{item.name}</div>
    </div>
  );
}

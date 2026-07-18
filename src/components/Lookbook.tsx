import { useState } from "react";
import { type Look } from "../types";
import { deleteLook } from "../store";
import { Thumb } from "./Thumb";
import { useObjectUrl } from "../lib/useObjectUrl";

export function Lookbook({
  looks,
  reload,
}: {
  looks: Look[];
  reload: () => void;
}) {
  const [preview, setPreview] = useState<Look | null>(null);

  async function remove(id: string) {
    if (!confirm("Delete this saved look?")) return;
    await deleteLook(id);
    if (preview?.id === id) setPreview(null);
    reload();
  }

  return (
    <div>
      <div className="section-title">
        <h2>Lookbook</h2>
        <span className="count">{looks.length}</span>
      </div>

      {looks.length === 0 ? (
        <div className="empty">
          <div className="big">📸</div>
          No saved looks yet. Create an outfit in the Style studio and hit “Save
          look”.
        </div>
      ) : (
        <div className="grid">
          {looks.map((look) => (
            <div
              className="card selectable"
              key={look.id}
              onClick={() => setPreview(look)}
            >
              <Thumb blob={look.result} alt={look.name} />
              <button
                className="icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(look.id);
                }}
              >
                ✕
              </button>
              <div className="meta">
                <div className="name">{look.name}</div>
                <div className="tag">{look.itemIds.length} pieces</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <LookPreview look={preview} onClose={() => setPreview(null)} onDelete={remove} />
      )}
    </div>
  );
}

function LookPreview({
  look,
  onClose,
  onDelete,
}: {
  look: Look;
  onClose: () => void;
  onDelete: (id: string) => void;
}) {
  const url = useObjectUrl(look.result);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>{look.name}</h3>
        <div className="stage" style={{ marginBottom: 14, maxHeight: "60vh" }}>
          {url && <img src={url} alt={look.name} />}
        </div>
        <div className="row">
          <a
            className="btn"
            href={url ?? "#"}
            download={`look-${look.name}.png`}
            style={{ textDecoration: "none" }}
          >
            ⬇️ Download
          </a>
          <button className="btn danger" onClick={() => onDelete(look.id)}>
            Delete
          </button>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

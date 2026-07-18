import { type ModelPhoto } from "../types";
import { deleteModel, putModel, uid } from "../db";
import { processUpload } from "../lib/image";
import { Thumb } from "./Thumb";
import { UploadButton } from "./UploadButton";

export function MePhoto({
  models,
  activeId,
  setActiveId,
  reload,
}: {
  models: ModelPhoto[];
  activeId: string | null;
  setActiveId: (id: string) => void;
  reload: () => void;
}) {
  async function add(file: File) {
    const blob = await processUpload(file);
    const model: ModelPhoto = {
      id: uid(),
      name: `Photo ${models.length + 1}`,
      image: blob,
      createdAt: Date.now(),
    };
    await putModel(model);
    setActiveId(model.id);
    reload();
  }

  async function remove(id: string) {
    if (!confirm("Delete this photo of you?")) return;
    await deleteModel(id);
    reload();
  }

  return (
    <div>
      <div className="section-title">
        <h2>Photos of you</h2>
        <span className="count">{models.length}</span>
      </div>

      <p className="note" style={{ marginBottom: 14 }}>
        Add a clear, well-lit, full-body photo standing straight against a plain
        background for the best try-on results. Tap a photo to make it the one
        outfits are rendered on. Photos stay on this device.
      </p>

      <div style={{ marginBottom: 16 }}>
        <div className="row">
          <UploadButton onFile={add} className="btn primary" capture>
            📷 Take photo
          </UploadButton>
          <UploadButton onFile={add} className="btn">
            🖼️ Upload photo
          </UploadButton>
        </div>
      </div>

      {models.length === 0 ? (
        <div className="empty">
          <div className="big">🧍</div>
          No photos yet. Add one so we can dress you up.
        </div>
      ) : (
        <div className="grid">
          {models.map((m) => (
            <div
              className={`card selectable ${m.id === activeId ? "selected" : ""}`}
              key={m.id}
              onClick={() => setActiveId(m.id)}
            >
              <Thumb blob={m.image} alt={m.name} />
              {m.id === activeId && <div className="check">✓</div>}
              <button
                className="icon-btn"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(m.id);
                }}
              >
                ✕
              </button>
              <div className="meta">
                <div className="name">
                  {m.id === activeId ? "Active" : "Tap to use"}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

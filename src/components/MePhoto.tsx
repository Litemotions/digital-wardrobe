import { useState } from "react";
import { type ModelPhoto } from "../types";
import { deleteModel, putModel, uid } from "../db";
import { processUpload } from "../lib/image";
import { cutOutBackground } from "../lib/bg";
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
  const [busy, setBusy] = useState<string | null>(null);

  async function add(file: File) {
    try {
      setBusy("Preparing photo…");
      let blob = await processUpload(file);
      try {
        setBusy("Removing background… (first time downloads a small model)");
        blob = await cutOutBackground(blob);
      } catch {
        // If cutout fails (e.g. offline before the model is cached), keep the
        // original photo rather than blocking the upload.
      }
      const model: ModelPhoto = {
        id: uid(),
        name: `Photo ${models.length + 1}`,
        image: blob,
        createdAt: Date.now(),
      };
      await putModel(model);
      setActiveId(model.id);
      reload();
    } finally {
      setBusy(null);
    }
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
        Add a clear, well-lit, full-body photo standing straight. The background
        is removed automatically so try-on focuses on you. Tap a photo to make
        it the one outfits are rendered on. Photos stay on this device.
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

      {models.length === 0 && !busy ? (
        <div className="empty">
          <div className="big">🧍</div>
          No photos yet. Add one so we can dress you up.
        </div>
      ) : (
        <div className="grid">
          {busy && (
            <div className="card">
              <div className="thumb" style={{ display: "grid", placeItems: "center" }}>
                <div className="loading">
                  <div className="spinner" />
                </div>
              </div>
              <div className="meta">
                <div className="tag">{busy}</div>
              </div>
            </div>
          )}
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

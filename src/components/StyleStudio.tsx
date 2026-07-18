import { useMemo, useState } from "react";
import {
  CATEGORIES,
  categoryEmoji,
  type Category,
  type ClothingItem,
  type ModelPhoto,
} from "../types";
import { putLook, uid } from "../db";
import { generateTryOn, TryOnError } from "../lib/tryon";
import { Thumb } from "./Thumb";
import { useObjectUrl } from "../lib/useObjectUrl";

const SINGLE: Category[] = ["top", "bottom", "dress", "outerwear", "shoes"];

export function StyleStudio({
  models,
  activeId,
  items,
  reloadLooks,
  goToMe,
  goToWardrobe,
  toast,
}: {
  models: ModelPhoto[];
  activeId: string | null;
  items: ClothingItem[];
  reloadLooks: () => void;
  goToMe: () => void;
  goToWardrobe: () => void;
  toast: (msg: string, error?: boolean) => void;
}) {
  const activeModel = models.find((m) => m.id === activeId) ?? null;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Blob | null>(null);

  const selectedItems = useMemo(
    () =>
      selectedIds
        .map((id) => items.find((i) => i.id === id))
        .filter((i): i is ClothingItem => Boolean(i)),
    [selectedIds, items]
  );

  const resultUrl = useObjectUrl(result);
  const modelUrl = useObjectUrl(activeModel?.image);

  function toggle(item: ClothingItem) {
    setResult(null);
    setSelectedIds((prev) => {
      if (prev.includes(item.id)) return prev.filter((id) => id !== item.id);
      let next = prev;
      if (SINGLE.includes(item.category)) {
        // one garment per single-slot category
        next = prev.filter((id) => {
          const other = items.find((i) => i.id === id);
          return other?.category !== item.category;
        });
      }
      return [...next, item.id];
    });
  }

  async function run() {
    if (!activeModel || selectedItems.length === 0) return;
    setBusy(true);
    setResult(null);
    try {
      const { image } = await generateTryOn(
        activeModel,
        selectedItems,
        notes.trim() || undefined
      );
      setResult(image);
    } catch (err) {
      if (err instanceof TryOnError) {
        toast(err.hint ? `${err.message} ${err.hint}` : err.message, true);
      } else {
        toast("Something went wrong generating the look.", true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveLook() {
    if (!result || !activeModel) return;
    await putLook({
      id: uid(),
      name: new Date().toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
      modelId: activeModel.id,
      itemIds: selectedIds,
      result,
      createdAt: Date.now(),
    });
    reloadLooks();
    toast("Saved to your lookbook 💜");
  }

  if (!activeModel) {
    return (
      <div className="empty">
        <div className="big">🧍</div>
        Add a photo of yourself first, then come back to try outfits on.
        <div style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={goToMe}>
            Add your photo
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="section-title">
        <h2>Style studio</h2>
      </div>

      <div className="studio-preview">
        <div className="stage">
          {busy ? (
            <div className="loading">
              <div className="spinner" />
              <div>Dressing you up…</div>
            </div>
          ) : result && resultUrl ? (
            <img src={resultUrl} alt="Your outfit" />
          ) : modelUrl ? (
            <img src={modelUrl} alt="You" style={{ opacity: 0.9 }} />
          ) : (
            <div className="placeholder">No photo</div>
          )}
        </div>

        <div>
          <div className="note" style={{ marginBottom: 10 }}>
            {result
              ? "Here's your look. Save it or tweak the pieces and re-run."
              : "Pick pieces below, then render them onto your photo."}
          </div>

          {selectedItems.length > 0 ? (
            <div className="selected-strip" style={{ marginBottom: 12 }}>
              {selectedItems.map((it) => (
                <span className="pill" key={it.id}>
                  <Thumb blob={it.image} alt={it.name} className="" />
                  {categoryEmoji(it.category)}
                  <button onClick={() => toggle(it)}>✕</button>
                </span>
              ))}
            </div>
          ) : (
            <div className="note" style={{ marginBottom: 12 }}>
              Nothing selected yet.
            </div>
          )}

          <div className="field">
            <label>Styling notes (optional)</label>
            <textarea
              value={notes}
              placeholder="e.g. tuck the shirt in, sleeves rolled up"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <button
            className="btn primary block"
            disabled={busy || selectedItems.length === 0}
            onClick={run}
          >
            {busy ? (
              <>
                <span className="spinner" /> Rendering…
              </>
            ) : result ? (
              "🔁 Re-render"
            ) : (
              "✨ Try it on me"
            )}
          </button>

          {result && (
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={saveLook}>
                💾 Save look
              </button>
              <a
                className="btn ghost"
                href={resultUrl ?? "#"}
                download="try-on.png"
                style={{ textDecoration: "none" }}
              >
                ⬇️ Download
              </a>
            </div>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty">
          Add some clothing items to your wardrobe to start mixing & matching.
          <div style={{ marginTop: 16 }}>
            <button className="btn primary" onClick={goToWardrobe}>
              Go to wardrobe
            </button>
          </div>
        </div>
      ) : (
        CATEGORIES.map((cat) => {
          const catItems = items.filter((i) => i.category === cat.id);
          if (catItems.length === 0) return null;
          return (
            <div key={cat.id}>
              <div className="section-title">
                <h2>
                  {cat.emoji} {cat.label}
                </h2>
              </div>
              <div className="grid">
                {catItems.map((item) => {
                  const selected = selectedIds.includes(item.id);
                  return (
                    <div
                      key={item.id}
                      className={`card selectable ${selected ? "selected" : ""}`}
                      onClick={() => toggle(item)}
                    >
                      <Thumb blob={item.image} alt={item.name} />
                      {selected && <div className="check">✓</div>}
                      <div className="meta">
                        <div className="name">{item.name || "Untitled"}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

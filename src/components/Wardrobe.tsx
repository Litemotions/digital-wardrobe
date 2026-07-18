import { useMemo, useState } from "react";
import {
  CATEGORIES,
  categoryEmoji,
  categoryLabel,
  type Category,
  type ClothingItem,
} from "../types";
import { deleteItem, putItem, uid } from "../store";
import { processUpload } from "../lib/image";
import { Thumb } from "./Thumb";
import { UploadButton } from "./UploadButton";

export function Wardrobe({
  items,
  reload,
}: {
  items: ClothingItem[];
  reload: () => void;
}) {
  const [filter, setFilter] = useState<Category | "all">("all");
  const [draft, setDraft] = useState<{ blob: Blob } | null>(null);

  const filtered = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.category === filter)),
    [items, filter]
  );

  async function pickFile(file: File) {
    const blob = await processUpload(file);
    setDraft({ blob });
  }

  async function remove(id: string) {
    if (!confirm("Remove this item from your wardrobe?")) return;
    await deleteItem(id);
    reload();
  }

  return (
    <div>
      <div className="section-title">
        <h2>Your wardrobe</h2>
        <span className="count">{items.length} items</span>
      </div>

      <div className="chips">
        <button
          className={`chip ${filter === "all" ? "active" : ""}`}
          onClick={() => setFilter("all")}
        >
          All
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={`chip ${filter === c.id ? "active" : ""}`}
            onClick={() => setFilter(c.id)}
          >
            {c.emoji} {c.label}
          </button>
        ))}
      </div>

      <div style={{ margin: "12px 0 16px" }}>
        <UploadButton onFile={pickFile} className="btn primary block">
          ＋ Add clothing item
        </UploadButton>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <div className="big">🧺</div>
          {items.length === 0
            ? "Your wardrobe is empty. Snap or upload a photo of a clothing item to get started."
            : `No ${categoryLabel(filter as Category).toLowerCase()} yet.`}
        </div>
      ) : (
        <div className="grid">
          {filtered.map((item) => (
            <div className="card" key={item.id}>
              <Thumb blob={item.image} alt={item.name} />
              <button
                className="icon-btn"
                title="Remove"
                onClick={() => remove(item.id)}
              >
                ✕
              </button>
              <div className="meta">
                <div className="name">{item.name || "Untitled"}</div>
                <div className="tag">
                  {categoryEmoji(item.category)} {categoryLabel(item.category)}
                  {item.color ? ` · ${item.color}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <AddItemSheet
          blob={draft.blob}
          onCancel={() => setDraft(null)}
          onSave={async (data) => {
            const item: ClothingItem = {
              id: uid(),
              image: draft.blob,
              createdAt: Date.now(),
              ...data,
            };
            await putItem(item);
            setDraft(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function AddItemSheet({
  blob,
  onCancel,
  onSave,
}: {
  blob: Blob;
  onCancel: () => void;
  onSave: (data: {
    name: string;
    category: Category;
    color?: string;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("top");
  const [color, setColor] = useState("");

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>Add to wardrobe</h3>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div style={{ maxWidth: 150 }}>
            <div className="uploader" style={{ aspectRatio: "3 / 4" }}>
              <Thumb blob={blob} alt="New item" className="thumb" />
            </div>
          </div>
          <div style={{ flex: 1.4 }}>
            <div className="field">
              <label>Name (optional)</label>
              <input
                type="text"
                value={name}
                placeholder="e.g. White linen shirt"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.emoji} {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Color (optional)</label>
              <input
                type="text"
                value={color}
                placeholder="e.g. Navy"
                onChange={(e) => setColor(e.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() =>
              onSave({ name: name.trim(), category, color: color.trim() || undefined })
            }
          >
            Save item
          </button>
        </div>
      </div>
    </div>
  );
}

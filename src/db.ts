import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ClothingItem, ModelPhoto, Look } from "./types";

interface WardrobeDB extends DBSchema {
  items: {
    key: string;
    value: ClothingItem;
    indexes: { byCreated: number };
  };
  models: {
    key: string;
    value: ModelPhoto;
    indexes: { byCreated: number };
  };
  looks: {
    key: string;
    value: Look;
    indexes: { byCreated: number };
  };
}

let dbPromise: Promise<IDBPDatabase<WardrobeDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<WardrobeDB>("digital-wardrobe", 1, {
      upgrade(db) {
        const items = db.createObjectStore("items", { keyPath: "id" });
        items.createIndex("byCreated", "createdAt");
        const models = db.createObjectStore("models", { keyPath: "id" });
        models.createIndex("byCreated", "createdAt");
        const looks = db.createObjectStore("looks", { keyPath: "id" });
        looks.createIndex("byCreated", "createdAt");
      },
    });
  }
  return dbPromise;
}

export function uid(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

// Items -----------------------------------------------------------------
export async function getItems(): Promise<ClothingItem[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("items", "byCreated");
  return all.reverse();
}

export async function putItem(item: ClothingItem): Promise<void> {
  const db = await getDB();
  await db.put("items", item);
}

export async function deleteItem(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("items", id);
}

// Models ----------------------------------------------------------------
export async function getModels(): Promise<ModelPhoto[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("models", "byCreated");
  return all.reverse();
}

export async function putModel(model: ModelPhoto): Promise<void> {
  const db = await getDB();
  await db.put("models", model);
}

export async function deleteModel(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("models", id);
}

// Looks -----------------------------------------------------------------
export async function getLooks(): Promise<Look[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex("looks", "byCreated");
  return all.reverse();
}

export async function putLook(look: Look): Promise<void> {
  const db = await getDB();
  await db.put("looks", look);
}

export async function deleteLook(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("looks", id);
}

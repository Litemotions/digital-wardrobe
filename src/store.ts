// Unified data access. Routes to the cloud API when the user is signed in
// (VITE_API_BASE set + token present), otherwise to on-device IndexedDB.
import * as local from "./db";
import * as remote from "./lib/api";
import { isAuthed } from "./lib/api";
import type { ClothingItem, Look, ModelPhoto } from "./types";

export { uid } from "./db";

const cloud = () => isAuthed();

export const getItems = (): Promise<ClothingItem[]> =>
  cloud() ? remote.getItems() : local.getItems();
export const putItem = (i: ClothingItem): Promise<void> =>
  cloud() ? remote.putItem(i) : local.putItem(i);
export const deleteItem = (id: string): Promise<void> =>
  cloud() ? remote.deleteItem(id) : local.deleteItem(id);

export const getModels = (): Promise<ModelPhoto[]> =>
  cloud() ? remote.getModels() : local.getModels();
export const putModel = (m: ModelPhoto): Promise<void> =>
  cloud() ? remote.putModel(m) : local.putModel(m);
export const deleteModel = (id: string): Promise<void> =>
  cloud() ? remote.deleteModel(id) : local.deleteModel(id);

export const getLooks = (): Promise<Look[]> =>
  cloud() ? remote.getLooks() : local.getLooks();
export const putLook = (l: Look): Promise<void> =>
  cloud() ? remote.putLook(l) : local.putLook(l);
export const deleteLook = (id: string): Promise<void> =>
  cloud() ? remote.deleteLook(id) : local.deleteLook(id);

import type { ClothingItem, Look, ModelPhoto } from "../types";
import { blobToBase64 } from "./image";

// Base URL of the home API server (set VITE_API_BASE at build time). When it's
// empty the app runs in local/offline mode with no accounts.
const API_BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/$/, "");
const TOKEN_KEY = "dw.token";

export interface User {
  id: string;
  email: string;
  isAdmin?: boolean;
}

export interface AllowedEmail {
  email: string;
  isAdmin: boolean;
  invitedBy?: string;
  createdAt: number;
}

export function cloudEnabled(): boolean {
  return API_BASE.length > 0;
}
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}
export function isAuthed(): boolean {
  return cloudEnabled() && !!getToken();
}

function imgUrl(path: string): string {
  return `${API_BASE}${path}?token=${encodeURIComponent(getToken() || "")}`;
}

async function req(path: string, options: RequestInit = {}): Promise<any> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (HTTP ${res.status}).`);
  }
  return data;
}

// --- Auth (magic link) ------------------------------------------------
export async function requestLink(email: string): Promise<void> {
  await req("/auth/request-link", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}
export async function verifyLink(token: string): Promise<User> {
  const data = await req("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  setToken(data.token);
  return data.user;
}
export async function me(): Promise<User> {
  const data = await req("/auth/me");
  return data.user;
}

// --- Admin: invite allowlist -----------------------------------------
export async function listAllowed(): Promise<AllowedEmail[]> {
  return req("/admin/allowed");
}
export async function addAllowed(email: string, isAdmin = false): Promise<void> {
  await req("/admin/allowed", {
    method: "POST",
    body: JSON.stringify({ email, isAdmin }),
  });
}
export async function removeAllowed(email: string): Promise<void> {
  await req(`/admin/allowed/${encodeURIComponent(email)}`, {
    method: "DELETE",
  });
}

// --- Items ------------------------------------------------------------
export async function getItems(): Promise<ClothingItem[]> {
  const rows = await req("/items");
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    color: r.color,
    createdAt: r.createdAt,
    image: imgUrl(r.imageUrl),
  }));
}
export async function putItem(item: ClothingItem): Promise<void> {
  if (typeof item.image === "string") return; // already stored
  await req("/items", {
    method: "POST",
    body: JSON.stringify({
      id: item.id,
      name: item.name,
      category: item.category,
      color: item.color,
      mime: item.image.type || "image/jpeg",
      imageBase64: await blobToBase64(item.image),
    }),
  });
}
export async function deleteItem(id: string): Promise<void> {
  await req(`/items/${id}`, { method: "DELETE" });
}

// --- Models -----------------------------------------------------------
export async function getModels(): Promise<ModelPhoto[]> {
  const rows = await req("/models");
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    image: imgUrl(r.imageUrl),
  }));
}
export async function putModel(model: ModelPhoto): Promise<void> {
  if (typeof model.image === "string") return;
  await req("/models", {
    method: "POST",
    body: JSON.stringify({
      id: model.id,
      name: model.name,
      mime: model.image.type || "image/png",
      imageBase64: await blobToBase64(model.image),
    }),
  });
}
export async function deleteModel(id: string): Promise<void> {
  await req(`/models/${id}`, { method: "DELETE" });
}

// --- Looks ------------------------------------------------------------
export async function getLooks(): Promise<Look[]> {
  const rows = await req("/looks");
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    modelId: r.modelId || "",
    itemIds: r.itemIds || [],
    createdAt: r.createdAt,
    result: imgUrl(r.imageUrl),
  }));
}
export async function putLook(look: Look): Promise<void> {
  if (typeof look.result === "string") return;
  await req("/looks", {
    method: "POST",
    body: JSON.stringify({
      id: look.id,
      name: look.name,
      modelId: look.modelId,
      itemIds: look.itemIds,
      mime: look.result.type || "image/png",
      imageBase64: await blobToBase64(look.result),
    }),
  });
}
export async function deleteLook(id: string): Promise<void> {
  await req(`/looks/${id}`, { method: "DELETE" });
}

import type { ClothingItem, ImageSrc, ModelPhoto } from "../types";
import { blobToBase64, base64ToBlob } from "./image";
import { categoryLabel } from "../types";

// Images may be a Blob (local mode) or a URL string (cloud mode). Normalise to
// { mime, base64 } for the API request.
async function toInline(src: ImageSrc): Promise<{ mime: string; data: string }> {
  const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
  return { mime: blob.type || "image/jpeg", data: await blobToBase64(blob) };
}

export interface TryOnResult {
  image: Blob;
}

export class TryOnError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "TryOnError";
  }
}

export async function generateTryOn(
  model: ModelPhoto,
  items: ClothingItem[],
  notes?: string
): Promise<TryOnResult> {
  const modelInline = await toInline(model.image);
  const garments = await Promise.all(
    items.map(async (it) => ({
      label: `${categoryLabel(it.category)}${it.name ? ` — ${it.name}` : ""}${
        it.color ? ` (${it.color})` : ""
      }`,
      ...(await toInline(it.image)),
    }))
  );

  let res: Response;
  try {
    res = await fetch("/api/tryon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelInline,
        garments,
        notes,
      }),
    });
  } catch {
    throw new TryOnError(
      "Couldn't reach the try-on service.",
      "Are you running the app with the serverless function available? See the README."
    );
  }

  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    /* ignore */
  }

  if (!res.ok) {
    const msg = payload?.error || `Try-on failed (HTTP ${res.status}).`;
    throw new TryOnError(msg, payload?.hint);
  }

  if (!payload?.image?.data) {
    throw new TryOnError(
      "The try-on service didn't return an image.",
      payload?.text ? `Model said: ${String(payload.text).slice(0, 300)}` : undefined
    );
  }

  const mime = payload.image.mime || "image/png";
  return { image: base64ToBlob(payload.image.data, mime) };
}

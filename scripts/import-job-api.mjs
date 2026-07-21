import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import sharp from "sharp";
import unzipper from "unzipper";

const API_ROOT = "/api/import/jobs";
const ASSET_ROOT = "/api/import/assets";
const LIBRARY_ASSET_ROOT = "/api/import/library";
const LOOKS_ROOT = "/api/import/looks";
const LOOKS_ASSET_ROOT = "/api/import/looks/image";
const STAGES = new Set(["crop", "garment", "modeled"]);
const DECISIONS = new Set(["approve", "reject"]);
const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"]);
const PART_LABELS = { upperbody: "Top", wholebody_up: "Jacket", lowerbody: "Bottom", accessories_up: "Accessory", shoes: "Shoes" };
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MAX_LOOK_ITEMS = 6;

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
}

function publicJob(job) {
  const copy = structuredClone(job);
  delete copy.internal;
  return copy;
}

function extension(mime = "image/png") {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" })[mime] || "png";
}

function decodeImage(input) {
  const raw = input.imageDataUrl || input.imageBase64;
  if (!raw || typeof raw !== "string") throw Object.assign(new Error("imageDataUrl or imageBase64 is required"), { status: 400 });
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  const mime = match?.[1] || input.mimeType || "image/png";
  const data = Buffer.from(match?.[2] || raw, "base64");
  if (!data.length) throw Object.assign(new Error("Image payload is empty"), { status: 400 });
  return { data, mime };
}

function normalizeMetadata(value = {}) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const color = typeof metadata.color === "string" && HEX_COLOR.test(metadata.color) ? metadata.color.toLowerCase() : "#d8d0c2";
  const secondaryColor = typeof metadata.secondaryColor === "string" && HEX_COLOR.test(metadata.secondaryColor) ? metadata.secondaryColor.toLowerCase() : null;
  return {
    name: typeof metadata.name === "string" ? metadata.name.trim().slice(0, 120) || "New piece" : "New piece",
    part: PARTS.has(metadata.part) ? metadata.part : "upperbody",
    color,
    secondaryColor,
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 12) : [],
    boundingBox: normalizeBoundingBox(metadata.boundingBox),
  };
}

function normalizeBoundingBox(value = {}) {
  const box = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = (key, fallback) => Number.isFinite(Number(box[key])) ? Math.round(Number(box[key])) : fallback;
  const x = Math.max(0, Math.min(999, number("x", 0)));
  const y = Math.max(0, Math.min(999, number("y", 0)));
  const width = Math.max(1, Math.min(1000 - x, number("width", 1000 - x)));
  const height = Math.max(1, Math.min(1000 - y, number("height", 1000 - y)));
  return { x, y, width, height };
}

// Caps the longest edge before anything goes to OpenAI or gets stored as an
// intermediate asset. Full-resolution phone photos (a model-reference.png
// can easily be 8-12 MB) make every generation call slow to upload and cost
// more input tokens for no visible quality gain — 1600px is already sharp
// enough for these use cases. withoutEnlargement keeps small images as-is.
async function normalizeImage(bytes, maxEdge = 1600) {
  return sharp(bytes)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .toColorspace("srgb")
    .png()
    .toBuffer();
}

async function cropDetectedItem(bytes, boundingBox) {
  const normalized = await normalizeImage(bytes);
  const { width, height } = await sharp(normalized).metadata();
  const box = normalizeBoundingBox(boundingBox);
  const rawLeft = (box.x / 1000) * width;
  const rawTop = (box.y / 1000) * height;
  const rawWidth = (box.width / 1000) * width;
  const rawHeight = (box.height / 1000) * height;
  // Thin, small, or low-contrast items (a belt against dark trousers, a
  // watch, a thin strap) are the easiest for the vision model to slightly
  // mis-locate, and a tight crop leaves zero margin for that error. Pad
  // generously relative to the box's own size, with an absolute floor tied
  // to the *source* image so very thin boxes still get a sensible amount of
  // surrounding context rather than a sliver.
  const paddingX = Math.max(24, Math.round(rawWidth * 0.25), Math.round(width * 0.035));
  const paddingY = Math.max(24, Math.round(rawHeight * 0.25), Math.round(height * 0.035));
  const left = Math.max(0, Math.floor(rawLeft - paddingX));
  const top = Math.max(0, Math.floor(rawTop - paddingY));
  const right = Math.min(width, Math.ceil(rawLeft + rawWidth + paddingX));
  const bottom = Math.min(height, Math.ceil(rawTop + rawHeight + paddingY));
  return sharp(normalized).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toBuffer();
}

function chooseChromaKey(primary = "#808080") {
  const value = HEX_COLOR.test(primary) ? primary : "#808080";
  const source = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const candidates = [[0, 255, 0], [255, 0, 255], [0, 255, 255]];
  const selected = candidates.sort((a, b) => {
    const distance = (color) => color.reduce((total, channel, index) => total + ((channel - source[index]) ** 2), 0);
    return distance(b) - distance(a);
  })[0];
  return `#${selected.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function buildGarmentPrompt(metadata = {}, chromaKey = "#00ff00") {
  const name = metadata.name || "clothing item";
  const category = metadata.part || "wardrobe item";
  const primary = metadata.color || "the exact visible color";
  const secondary = metadata.secondaryColor ? ` with distinct secondary color ${metadata.secondaryColor}` : "";
  const details = Array.isArray(metadata.tags) && metadata.tags.length
    ? metadata.tags.join(", ")
    : "all visible construction and design details";

  return `Use case: background-extraction
Asset type: ecommerce catalog product cutout source

Input image: The reference photograph shows the exact garment, either by itself or worn by a person. Use it only to identify and reconstruct the garment.

Primary request: Reconstruct ONLY the complete empty ${name} (${category}) as a clean, front-facing ecommerce catalog product photograph. If a wearer is present, remove them. Remove every other garment, object, and background element. Show the complete item naturally arranged and symmetrical, with no person, body, mannequin, or hanger visible.

Garment fidelity: Preserve the reference garment's exact primary color ${primary}${secondary}, material and texture, silhouette, neckline, sleeves, fastenings, pattern, and distinctive details (${details}). Preserve any clearly legible existing graphic or logo exactly, but do not invent or reinterpret uncertain logos, text, pockets, seams, hardware, colors, or decoration.

Composition: Centered straight-on product view. Keep the entire garment inside the frame with generous, even padding on every side. No cropping or truncation.

Background: Perfectly flat, absolutely uniform solid ${chromaKey} chroma-key color, edge-to-edge. No shadows, gradient, texture, vignette, floor, horizon, reflection, or lighting variation.

Lighting: Neutral diffuse product lighting contained on the garment only.

Avoid: person, body, skin, hair, mannequin, hanger, props, other garments, retail tags, cast shadow, contact shadow, reflection, watermark, caption, border, background variation, or chroma spill.

Critical: Use no ${chromaKey} anywhere in the garment. Produce exactly one complete garment with a crisp, separable outer silhouette.`;
}

function cleanupTolerance(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(18, Math.min(110, Math.round(parsed))) : 46;
}

function removeKeyedSpill(data, index, keyedChannels, neutralLevel) {
  let remaining = Math.ceil(keyedChannels.reduce((total, channel) => total + data[index + channel], 0) - (neutralLevel * keyedChannels.length));
  let active = keyedChannels.filter((channel) => data[index + channel] > 0);
  while (remaining > 0 && active.length) {
    const share = Math.ceil(remaining / active.length);
    const next = [];
    for (const channel of active) {
      const reduction = Math.min(data[index + channel], share, remaining);
      data[index + channel] -= reduction;
      remaining -= reduction;
      if (data[index + channel] > 0) next.push(channel);
    }
    active = next;
  }
}

export async function processChromaBackground(bytes, key, options = {}) {
  const tolerance = cleanupTolerance(options.tolerance);
  const feather = 80;
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const distance = Math.sqrt(
      ((data[index] - target[0]) ** 2)
      + ((data[index + 1] - target[1]) ** 2)
      + ((data[index + 2] - target[2]) ** 2),
    );
    if (distance <= tolerance) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
    } else {
      if (distance < tolerance + feather) data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / feather));
      const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
      const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
      const spill = Math.max(0, keyedLevel - neutralLevel);
      if (spill > 0) {
        const spillAlpha = Math.max(0, 1 - (Math.max(0, spill - 4) / 150));
        data[index + 3] = Math.round(data[index + 3] * spillAlpha);
        removeKeyedSpill(data, index, keyedChannels, neutralLevel);
      }
      if (data[index + 3] <= 8) {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
      }
    }
  }
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill > 0) {
      removeKeyedSpill(data, index, keyedChannels, neutralLevel);
    }
  }
  const keyedOutput = await sharp(data, { raw: info }).png().toBuffer();
  const framedOutput = await frameTransparentGarment(keyedOutput);
  const { data: framedData, info: framedInfo } = await sharp(framedOutput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < framedData.length; index += 4) {
    if (framedData[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + framedData[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + framedData[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill <= 0) continue;
    removeKeyedSpill(framedData, index, keyedChannels, neutralLevel);
  }
  const output = await sharp(framedData, { raw: framedInfo }).png().toBuffer();
  const verification = await verifyNoChromaSpill(output, key);
  return { bytes: output, verification, tolerance };
}

export async function removeChromaBackground(bytes, key, options = {}) {
  const result = await processChromaBackground(bytes, key, options);
  if (options.strict !== false && result.verification.contaminatedPixels > 1) {
    throw new Error(`Background cleanup left ${result.verification.contaminatedPixels} chroma-contaminated pixels`);
  }
  return result.bytes;
}

export async function frameTransparentGarment(bytes, canvasSize = 1024, occupancy = 0.88) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3] <= 8) continue;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error("Background removal did not leave a visible garment");

  const trimmed = await sharp(data, { raw: info })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();
  const targetSize = Math.max(1, Math.round(canvasSize * Math.max(0.5, Math.min(0.96, occupancy))));
  const resized = await sharp(trimmed)
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((canvasSize - resized.info.width) / 2);
  const top = Math.floor((canvasSize - resized.info.height) / 2);
  return sharp({ create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer();
}

async function verifyNoChromaSpill(bytes, key) {
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let contaminatedPixels = 0;
  let maxSpill = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const spill = Math.max(0, keyedLevel - neutralLevel);
    maxSpill = Math.max(maxSpill, spill);
    if (spill > 1.5) contaminatedPixels += 1;
  }
  return { contaminatedPixels, maxSpill };
}

async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(tmp, file);
  } catch (error) {
    if (!["EBUSY", "EXDEV", "EPERM"].includes(error.code)) {
      await rm(tmp, { force: true });
      throw error;
    }
    await copyFile(tmp, file);
    await rm(tmp, { force: true });
  }
}

function stageState() {
  return { status: "pending", decision: null, attempts: 0, assetUrl: null, failedAssetUrl: null, cleanupPreviewUrl: null, cleanupTolerance: 46, cleanupDiagnostics: null, error: null, prompt: null, updatedAt: null };
}

async function openAIEdit({ key, baseUrl, model, prompt, images, size, background, quality }) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("size", size);
  form.set("quality", quality || "high");
  form.set("output_format", "png");
  if (background) form.set("background", background);
  for (const [index, image] of images.entries()) {
    const normalized = await normalizeImage(image.data);
    form.append("image[]", new Blob([normalized], { type: "image/png" }), image.name?.replace(/\.[^.]+$/, ".png") || `image-${index + 1}.png`);
  }
  const response = await fetch(`${baseUrl}/images/edits`, {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI image request failed (${response.status})`);
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("OpenAI response did not contain image data");
  return Buffer.from(encoded, "base64");
}

async function openAIAnalyze({ key, baseUrl, model, image, mime, singleItem = false }) {
  // Two modes: the default detects and splits every distinct garment in a
  // photo (for flatlays / photos of someone wearing several pieces at once).
  // singleItem is for a photo the user already cropped to one item (or one
  // matching pair, e.g. both shoes) themselves — skip detection/splitting
  // entirely and describe the whole frame as exactly one wardrobe item.
  const detectionText = singleItem
    ? "This photo has already been cropped by the user to show exactly one wearable wardrobe item — it may be a matching pair (for example, both shoes of one pair, or a pair of gloves). Do not attempt to detect sub-regions or split it into multiple items. Return exactly one record describing this single item, with its bounding box covering the entire image: x:0, y:0, width:1000, height:1000. Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, shoes. Suggest a concise specific name, primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful lowercase detail tags."
    : "Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. If a matching pair of shoes (or gloves) is shown — both the left and right of the same pair — treat that pair as a SINGLE item; do not create two separate entries for one pair. Ignore the person's body and non-wearable background objects. For each item, include a bounding box around that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. The box should comfortably contain the whole item with a bit of margin around it — err on the side of a slightly generous box rather than a razor-tight one, especially for small, thin, or low-contrast items like belts, watches, or straps that are easy to mis-locate precisely. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, shoes. Suggest a concise specific name, primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful lowercase detail tags.";
  const itemCount = singleItem ? { minItems: 1, maxItems: 1 } : { minItems: 0, maxItems: 8 };
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: [
        { type: "input_text", text: detectionText },
        { type: "input_image", image_url: `data:${mime};base64,${image.toString("base64")}` },
      ] }],
      text: { format: { type: "json_schema", name: "wardrobe_items", strict: true, schema: { type: "object", additionalProperties: false, properties: { items: { type: "array", ...itemCount, items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, part: { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"] }, color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, secondaryColor: { anyOf: [{ type: "string", pattern: "^#[0-9A-Fa-f]{6}$" }, { type: "null" }] }, tags: { type: "array", items: { type: "string" }, maxItems: 4 }, boundingBox: { type: "object", additionalProperties: false, properties: { x: { type: "integer", minimum: 0, maximum: 999 }, y: { type: "integer", minimum: 0, maximum: 999 }, width: { type: "integer", minimum: 1, maximum: 1000 }, height: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["x", "y", "width", "height"] } }, required: ["name", "part", "color", "secondaryColor", "tags", "boundingBox"] } } }, required: ["items"] } } },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `OpenAI analysis failed (${response.status})`);
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("OpenAI analysis returned no structured result");
  const parsed = JSON.parse(outputText);
  if (!Array.isArray(parsed.items)) throw new Error("OpenAI analysis returned an invalid clothing list");
  return parsed.items;
}

const PAGE_FETCH_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_URL_IMAGE_BYTES = 20 * 1024 * 1024;

// Basic SSRF guard: this endpoint lets a signed-in user make the server
// fetch an arbitrary URL, so refuse anything obviously aimed at the local
// network or loopback rather than a public product page.
function isDisallowedHost(hostname) {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(lower)) return true;
  if (lower.endsWith(".local") || lower.endsWith(".internal")) return true;
  if (/^10\./.test(lower)) return true;
  if (/^192\.168\./.test(lower)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(lower)) return true;
  if (/^169\.254\./.test(lower)) return true;
  return false;
}

function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http:// and https:// links are supported.");
  if (isDisallowedHost(parsed.hostname)) throw new Error("That address isn't allowed.");
  return parsed;
}

// Finds the main product photo on a page via the same meta tags almost every
// e-commerce site already sets for link previews (Open Graph / Twitter Card),
// so this works across shops without per-site scraping rules.
async function extractProductImageUrl(pageUrl) {
  const parsed = assertPublicHttpUrl(pageUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let html;
  try {
    const response = await fetch(parsed.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": PAGE_FETCH_USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    });
    if (!response.ok) throw new Error(`Could not load that page (HTTP ${response.status}).`);
    html = await response.text();
  } finally {
    clearTimeout(timeout);
  }
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      try {
        return new URL(match[1], parsed).toString();
      } catch { /* try the next pattern */ }
    }
  }
  throw new Error("Couldn't find a product image on that page. Try saving the photo and uploading it instead.");
}

async function downloadImage(imageUrl) {
  const parsed = assertPublicHttpUrl(imageUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(parsed.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": PAGE_FETCH_USER_AGENT },
    });
    if (!response.ok) throw new Error(`Image request failed (HTTP ${response.status}).`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_URL_IMAGE_BYTES) throw new Error("That image is too large.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_URL_IMAGE_BYTES) throw new Error("That image is too large.");
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

export function wardrobeImportApi(options = {}) {
  let root;
  let jobsDir;
  let importedFile;
  let libraryAssetDir;
  let looksFile;
  let looksAssetDir;
  const running = new Map();
  // Tracks in-flight look generations so the HTTP request that kicks one off
  // can return immediately — Cloudflare (and most proxies) will kill a
  // request that takes the ~30-90s an OpenAI multi-image composite can need,
  // long before our own server would ever respond. The client polls this
  // instead, the same pattern the import job flow already uses.
  const lookJobs = new Map();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const apiBaseUrl = () => setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");

  async function setupStatus() {
    const hasApiKey = Boolean(setting("OPENAI_API_KEY").trim());
    const referenceSetting = setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png");
    const referencePath = path.resolve(root, referenceSetting);
    let hasModelReference = false;
    try {
      hasModelReference = (await stat(referencePath)).isFile();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return {
      ready: hasApiKey && hasModelReference,
      hasApiKey,
      hasModelReference,
      modelReference: referenceSetting,
    };
  }

  async function loadJob(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    try { return JSON.parse(await readFile(path.join(jobsDir, id, "job.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async function saveJob(job) {
    job.updatedAt = new Date().toISOString();
    await atomicJson(path.join(jobsDir, job.id, "job.json"), job);
  }

  async function loadImported() {
    try { return JSON.parse(await readFile(importedFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function persistImported(job, includeModeled = false) {
    const id = `import-${job.id}`;
    await mkdir(libraryAssetDir, { recursive: true });
    const garmentName = `${id}-garment.png`;
    const garmentSource = job.stages.garment.assetUrl
      ? path.basename(new URL(job.stages.garment.assetUrl, "http://localhost").pathname)
      : `garment-${job.stages.garment.attempts}.png`;
    await copyFile(path.join(jobsDir, job.id, garmentSource), path.join(libraryAssetDir, garmentName));
    let modeledImage = null;
    if (includeModeled) {
      const modeledName = `${id}-modeled.png`;
      const modeledSource = job.stages.modeled.assetUrl
        ? path.basename(new URL(job.stages.modeled.assetUrl, "http://localhost").pathname)
        : `modeled-${job.stages.modeled.attempts}.png`;
      await copyFile(path.join(jobsDir, job.id, modeledSource), path.join(libraryAssetDir, modeledName));
      modeledImage = `${LIBRARY_ASSET_ROOT}/${modeledName}`;
    }
    const metadata = job.metadata || {};
    const records = await loadImported();
    const existing = records.find((record) => record.id === id);
    const record = {
      id,
      name: metadata.name || "New piece",
      part: metadata.part || "upperbody",
      color: metadata.color || "#d8d0c2",
      secondaryColor: metadata.secondaryColor || null,
      palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
      tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      image: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      thumbnail: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      modeledImage: modeledImage || existing?.modeledImage || null,
      importJobId: job.id,
    };
    const next = [...records.filter((item) => item.id !== id), record];
    await atomicJson(importedFile, next);
    return record;
  }

  async function generate(job, stageName) {
    const lock = `${job.id}:${stageName}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      const current = await loadJob(job.id);
      const stage = current.stages[stageName];
      stage.status = "processing"; stage.decision = null; stage.error = null; stage.attempts += 1; stage.updatedAt = new Date().toISOString();
      await saveJob(current);
      let failedAssetUrl = null;
      let chromaKeyUsed = null;
      try {
        const dir = path.join(jobsDir, current.id);
        const output = path.join(dir, `${stageName}-${stage.attempts}.png`);
        const key = setting("OPENAI_API_KEY");
        if (!key) throw new Error("OPENAI_API_KEY is not configured");
        const sourceFile = stageName === "garment" && current.internal.cropFile ? current.internal.cropFile : current.internal.originalFile;
        const original = { data: await readFile(path.join(dir, sourceFile)), mime: "image/png", name: sourceFile };
        let bytes;
        if (stageName === "garment") {
          chromaKeyUsed = chooseChromaKey(current.metadata.color);
          const basePrompt = options.garmentPrompt || buildGarmentPrompt(current.metadata, chromaKeyUsed);
          bytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "high"), size: "1024x1024", images: [original], prompt: current.stages.garment.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.garment.prompt}` : basePrompt });
          const rawName = `${stageName}-${stage.attempts}-source.png`;
          await writeFile(path.join(dir, rawName), bytes);
          failedAssetUrl = `${ASSET_ROOT}/${current.id}/${rawName}`;
          bytes = await removeChromaBackground(bytes, chromaKeyUsed);
        } else {
          const garmentName = current.stages.garment.assetUrl
            ? path.basename(new URL(current.stages.garment.assetUrl, "http://localhost").pathname)
            : `garment-${current.stages.garment.attempts}.png`;
          const garmentFile = path.join(dir, garmentName);
          const garment = { data: await readFile(garmentFile), mime: "image/png", name: "garment.png" };
          const modelPath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
          let modelData;
          try {
            modelData = await readFile(modelPath);
          } catch (error) {
            if (error.code === "ENOENT") throw new Error(`Model reference not found at ${modelPath}. Set WARDROBE_MODEL_REFERENCE or add data/model-reference.png.`);
            throw error;
          }
          const model = { data: modelData, mime: "image/png", name: "model.png" };
          const basePrompt = options.modeledPrompt || "Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact garment from Image 2. Preserve the person's recognizable identity, face, hair, age and proportions. Preserve every garment color, material, fit, construction, graphic, logo and distinctive detail. Keep the complete featured item clearly visible and unobstructed, use understated neutral supporting clothes, realistic anatomy, natural light, authentic fabric, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.";
          bytes = await openAIEdit({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")), quality: setting("OPENAI_IMAGE_QUALITY", "high"), size: "1536x1024", images: [model, garment], prompt: current.stages.modeled.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.modeled.prompt}` : basePrompt });
        }
        await writeFile(output, bytes);
        const fresh = await loadJob(current.id);
        fresh.stages[stageName].status = "review";
        fresh.stages[stageName].assetUrl = `${ASSET_ROOT}/${fresh.id}/${path.basename(output)}`;
        fresh.stages[stageName].failedAssetUrl = null;
        fresh.stages[stageName].cleanupPreviewUrl = null;
        fresh.stages[stageName].cleanupDiagnostics = null;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        fresh.stages[stageName].updatedAt = new Date().toISOString();
        await saveJob(fresh);
      } catch (error) {
        const fresh = await loadJob(current.id);
        fresh.stages[stageName].status = "failed"; fresh.stages[stageName].error = error.message; fresh.stages[stageName].updatedAt = new Date().toISOString();
        if (typeof failedAssetUrl === "string") fresh.stages[stageName].failedAssetUrl = failedAssetUrl;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        await saveJob(fresh);
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/import/")) return next();
    try {
      if (url.pathname === "/api/import/wardrobe" && req.method === "GET") {
        return json(res, 200, await loadImported());
      }
      if (url.pathname === "/api/import/config" && req.method === "GET") {
        return json(res, 200, await setupStatus());
      }
      // Let the user upload their model-reference photo from the browser
      // instead of having to place a file on disk. Writes to WARDROBE_MODEL_REFERENCE.
      // Restore a wardrobe backup: streams a .zip of a `data/` folder
      // (library.json + imported/*.png + optional model-reference.png) and
      // merges it into this install. Existing items with the same id are
      // overwritten, so re-importing the same backup is safe and idempotent.
      if (url.pathname === "/api/import/restore" && req.method === "POST") {
        let libraryFromZip = null;
        let imageCount = 0;
        let modelReferenceRestored = false;
        try {
          await pipeline(req, unzipper.Parse().on("entry", async (entry) => {
            const fullPath = entry.path.replace(/\\/g, "/");
            const base = path.basename(fullPath);
            const isImportedImage = /(^|\/)imported\/[^/]+\.png$/i.test(fullPath);
            try {
              if (base === "library.json" && entry.type === "File") {
                const chunks = [];
                for await (const chunk of entry) chunks.push(chunk);
                try {
                  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                  if (Array.isArray(parsed)) libraryFromZip = parsed;
                } catch { /* keep going, log below */ }
              } else if (isImportedImage) {
                const out = path.join(libraryAssetDir, base);
                await mkdir(libraryAssetDir, { recursive: true });
                await pipeline(entry, createWriteStream(out));
                imageCount += 1;
              } else if (base === "model-reference.png") {
                const referencePath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
                await mkdir(path.dirname(referencePath), { recursive: true });
                await pipeline(entry, createWriteStream(referencePath));
                modelReferenceRestored = true;
              } else {
                entry.autodrain();
              }
            } catch (entryError) {
              console.warn("Restore: failed on entry", fullPath, entryError.message);
              entry.autodrain();
            }
          }));
        } catch (zipError) {
          return json(res, 400, { error: `Could not read the ZIP: ${zipError.message}` });
        }

        // Merge the library. Later duplicates overwrite earlier ones by id.
        let mergedCount = 0;
        if (Array.isArray(libraryFromZip)) {
          const existing = await loadImported();
          const byId = new Map(existing.map((item) => [item.id, item]));
          for (const item of libraryFromZip) {
            if (item && typeof item.id === "string") {
              byId.set(item.id, item);
              mergedCount += 1;
            }
          }
          await atomicJson(importedFile, Array.from(byId.values()));
        }

        return json(res, 200, {
          items: mergedCount,
          images: imageCount,
          modelReferenceRestored,
        });
      }
      if (url.pathname === "/api/import/setup/model-reference" && req.method === "POST") {
        const input = await body(req);
        const image = decodeImage(input);
        const referenceSetting = setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png");
        const referencePath = path.resolve(root, referenceSetting);
        await mkdir(path.dirname(referencePath), { recursive: true });
        // Normalise to PNG (and cap resolution — full-size phone photos are
        // needlessly slow to re-upload to OpenAI on every generation call).
        const png = await normalizeImage(image.data);
        await writeFile(referencePath, png);
        return json(res, 200, await setupStatus());
      }

      // --- Looks: compose a photo of you wearing several selected items ---
      // one OpenAI call for the whole outfit (not one per item), and only
      // when the user explicitly asks — this is the expensive step, so it's
      // opt-in rather than automatic like the old per-item modeled preview.
      async function loadLooks() {
        try { return JSON.parse(await readFile(looksFile, "utf8")); }
        catch (error) { if (error.code === "ENOENT") return []; throw error; }
      }

      if (url.pathname === LOOKS_ROOT && req.method === "GET") {
        const looks = await loadLooks();
        return json(res, 200, [...looks].sort((a, b) => b.createdAt - a.createdAt));
      }

      if (url.pathname === `${LOOKS_ROOT}/generate` && req.method === "POST") {
        const setup = await setupStatus();
        if (!setup.ready) {
          console.warn("[looks/generate] setup not ready:", setup);
          return json(res, 503, { error: "Setup required: add your OpenAI API key and a model reference photo first." });
        }
        const input = await body(req);
        const itemIds = Array.isArray(input.itemIds) ? [...new Set(input.itemIds)].filter((id) => typeof id === "string") : [];
        if (!itemIds.length) return json(res, 400, { error: "Pick at least one item to generate a look." });
        if (itemIds.length > MAX_LOOK_ITEMS) return json(res, 400, { error: `Pick at most ${MAX_LOOK_ITEMS} items for one look.` });

        const records = await loadImported();
        const selected = itemIds.map((id) => records.find((record) => record.id === id)).filter(Boolean);
        if (selected.length !== itemIds.length) {
          console.warn("[looks/generate] items not found:", { requested: itemIds, matched: selected.map((r) => r.id) });
          return json(res, 404, { error: "One or more selected items were not found." });
        }

        const key = setting("OPENAI_API_KEY");
        const modelPath = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
        let modelData;
        try {
          modelData = await readFile(modelPath);
        } catch (error) {
          if (error.code === "ENOENT") return json(res, 503, { error: `Model reference not found at ${modelPath}. Upload one from the wardrobe setup screen.` });
          console.error("[looks/generate] failed reading model reference:", error);
          throw error;
        }

        const garmentImages = [];
        for (const record of selected) {
          const file = path.join(libraryAssetDir, path.basename(new URL(record.image, "http://localhost").pathname));
          try {
            garmentImages.push({ data: await readFile(file), name: `${record.id}.png`, label: `${PART_LABELS[record.part] || "Item"} — ${record.name}${record.color ? ` (${record.color})` : ""}` });
          } catch (error) {
            console.error(`[looks/generate] failed reading garment image for ${record.id} at ${file}:`, error);
            return json(res, 404, { error: `Could not read the image for "${record.name}".` });
          }
        }

        const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 300) : "";
        const garmentList = garmentImages.map((image, index) => `Image ${index + 2}: ${image.label}`).join("\n");
        const prompt = [
          "Create a professional vertical 3:4 editorial fashion photograph of the person in Image 1",
          `wearing this complete outfit, combining all of the following garments together naturally:`,
          garmentList,
          "",
          "Preserve the person's recognizable identity, face, hair, age, and body proportions exactly.",
          "Preserve every garment's color, material, fit, construction, graphic, logo, and distinctive",
          "detail exactly as shown, including sleeve length and how it fastens. Wear each garment plainly",
          "and neutrally exactly as shown in its reference image — do NOT roll up or push up sleeves, do",
          "NOT tuck in or untuck shirts, do NOT add layers, and do NOT change how any piece is worn, unless",
          "explicitly instructed below. Do NOT add any accessories, jewelry, watches, hats, bags, belts, or",
          "any other item that is not one of the garments shown. Use natural light, authentic fabric",
          "texture, and a tasteful real-world setting. No text, watermark, product mockup, or synthetic",
          "appearance.",
          notes ? `\nAdditional styling instructions from the user (these override the defaults above): ${notes}` : "",
        ].join("\n");

        const lookModel = setting("OPENAI_LOOK_MODEL", setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")));
        const lookQuality = setting("OPENAI_IMAGE_QUALITY", "high");

        // Kick off the actual OpenAI call in the background and respond right
        // away — a long-held request through Cloudflare's tunnel gets killed
        // (~100s gateway timeout) well before a multi-image "high" quality
        // composite can finish, which is what was causing silent failures.
        const id = randomUUID();
        lookJobs.set(id, { status: "processing", itemIds, createdAt: Date.now() });
        (async () => {
          try {
            const bytes = await openAIEdit({
              key,
              baseUrl: apiBaseUrl(),
              model: lookModel,
              quality: lookQuality,
              size: "1024x1536",
              images: [{ data: modelData, mime: "image/png", name: "model.png" }, ...garmentImages],
              prompt,
            });
            await mkdir(looksAssetDir, { recursive: true });
            await writeFile(path.join(looksAssetDir, `${id}.png`), bytes);
            lookJobs.set(id, { status: "complete", itemIds, image: `${LOOKS_ASSET_ROOT}/${id}.png`, createdAt: Date.now() });
          } catch (error) {
            console.error(`[looks/generate] OpenAI call failed (model=${lookModel}, quality=${lookQuality}, images=${garmentImages.length + 1}):`, error);
            lookJobs.set(id, { status: "failed", itemIds, error: error.message || "Could not generate that look.", createdAt: Date.now() });
          }
        })();
        // Prune anything older than 30 minutes so this Map can't grow forever.
        const cutoff = Date.now() - 30 * 60 * 1000;
        for (const [jobId, job] of lookJobs) if (job.createdAt < cutoff) lookJobs.delete(jobId);

        return json(res, 202, { id, status: "processing" });
      }

      const lookJobMatch = url.pathname.match(/^\/api\/import\/looks\/generate\/([a-f0-9-]{36})$/i);
      if (lookJobMatch && req.method === "GET") {
        const job = lookJobs.get(lookJobMatch[1]);
        if (!job) return json(res, 404, { error: "That look request has expired. Try generating again." });
        return json(res, 200, { id: lookJobMatch[1], ...job });
      }

      if (url.pathname === LOOKS_ROOT && req.method === "POST") {
        const input = await body(req);
        const { id, itemIds, name } = input || {};
        if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) return json(res, 400, { error: "Missing or invalid look id." });
        await stat(path.join(looksAssetDir, `${id}.png`)).catch(() => { throw Object.assign(new Error("That generated look has expired — generate it again."), { status: 404 }); });
        const looks = await loadLooks();
        const record = {
          id,
          name: typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : new Date().toLocaleDateString(),
          itemIds: Array.isArray(itemIds) ? itemIds : [],
          image: `${LOOKS_ASSET_ROOT}/${id}.png`,
          createdAt: Date.now(),
        };
        await atomicJson(looksFile, [...looks.filter((look) => look.id !== id), record]);
        return json(res, 200, record);
      }

      const lookDeleteMatch = url.pathname.match(/^\/api\/import\/looks\/([a-f0-9-]{36})$/i);
      if (lookDeleteMatch && req.method === "DELETE") {
        const id = lookDeleteMatch[1];
        const looks = await loadLooks();
        const next = looks.filter((look) => look.id !== id);
        if (next.length === looks.length) return json(res, 404, { error: "Look not found" });
        await atomicJson(looksFile, next);
        await rm(path.join(looksAssetDir, `${id}.png`), { force: true });
        return json(res, 200, { deleted: true, id });
      }

      if (lookDeleteMatch && req.method === "PATCH") {
        const id = lookDeleteMatch[1];
        const input = await body(req);
        const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
        if (!name) return json(res, 400, { error: "Give this look a name." });
        const looks = await loadLooks();
        const look = looks.find((item) => item.id === id);
        if (!look) return json(res, 404, { error: "Look not found." });
        const updated = { ...look, name };
        await atomicJson(looksFile, looks.map((item) => item.id === id ? updated : item));
        return json(res, 200, updated);
      }

      const lookImageMatch = url.pathname.match(/^\/api\/import\/looks\/image\/([\w.-]+)$/i);
      if (lookImageMatch && req.method === "GET") {
        const file = path.join(looksAssetDir, path.basename(lookImageMatch[1]));
        await stat(file);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(await readFile(file));
      }

      // Fix a styling detail on an already-saved look (same idea as the
      // wardrobe item "Regenerate image" field). Only the current look photo
      // is sent back — the garments/model reference don't need re-sending,
      // the correction is a targeted edit of the existing composite — and
      // this is just as slow as the original composite, so it's the same
      // async job + poll pattern (reusing the /looks/generate/:id poller).
      const lookRegenerateMatch = url.pathname.match(/^\/api\/import\/looks\/([a-f0-9-]{36})\/regenerate$/i);
      if (lookRegenerateMatch && req.method === "POST") {
        const id = lookRegenerateMatch[1];
        const setup = await setupStatus();
        if (!setup.ready) return json(res, 503, { error: "Setup required: add your OpenAI API key first." });
        const looks = await loadLooks();
        const look = looks.find((item) => item.id === id);
        if (!look) return json(res, 404, { error: "Look not found." });
        const input = await body(req);
        const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 500) : "";
        if (!prompt) return json(res, 400, { error: "Describe what to change, e.g. \"untuck the shirt\"." });

        const currentFile = path.join(looksAssetDir, path.basename(new URL(look.image, "http://localhost").pathname));
        let currentImage;
        try {
          currentImage = await readFile(currentFile);
        } catch (error) {
          console.error(`[looks/regenerate] could not read ${currentFile}:`, error);
          return json(res, 404, { error: "Could not read this look's current image." });
        }

        const key = setting("OPENAI_API_KEY");
        const lookModel = setting("OPENAI_LOOK_MODEL", setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")));
        const lookQuality = setting("OPENAI_IMAGE_QUALITY", "high");
        const fullPrompt = [
          "This is a professional editorial fashion photograph of a person wearing a complete outfit.",
          "Keep the person's identity, pose, framing, lighting, background, and every garment's color,",
          "material, fit, and construction exactly as shown. Apply ONLY this specific correction and",
          "change nothing else:",
          prompt,
        ].join("\n");

        const jobId = randomUUID();
        lookJobs.set(jobId, { status: "processing", itemIds: look.itemIds, createdAt: Date.now() });
        (async () => {
          try {
            let bytes = await openAIEdit({
              key,
              baseUrl: apiBaseUrl(),
              model: lookModel,
              quality: lookQuality,
              size: "1024x1536",
              images: [{ data: currentImage, mime: "image/png", name: "current.png" }],
              prompt: fullPrompt,
            });
            await writeFile(currentFile, bytes);
            // Same cache-busting-must-be-persisted fix as the wardrobe item
            // regenerate endpoint: the file is served immutable for a year
            // under an unchanging filename, so the saved record needs a
            // fresh URL or a page refresh will show the stale cached image.
            const bustedImage = `${LOOKS_ASSET_ROOT}/${path.basename(currentFile)}?v=${Date.now()}`;
            const freshLooks = await loadLooks();
            const nextLooks = freshLooks.map((item) => item.id === id ? { ...item, image: bustedImage } : item);
            await atomicJson(looksFile, nextLooks);
            lookJobs.set(jobId, { status: "complete", itemIds: look.itemIds, image: bustedImage, createdAt: Date.now() });
          } catch (error) {
            console.error(`[looks/regenerate] OpenAI call failed (model=${lookModel}, quality=${lookQuality}) for ${id}:`, error);
            lookJobs.set(jobId, { status: "failed", itemIds: look.itemIds, error: error.message || "Could not regenerate that look.", createdAt: Date.now() });
          }
        })();
        const cutoff = Date.now() - 30 * 60 * 1000;
        for (const [existingJobId, job] of lookJobs) if (job.createdAt < cutoff) lookJobs.delete(existingJobId);

        return json(res, 202, { id: jobId, status: "processing" });
      }

      // Regenerate an already-saved wardrobe item's garment image with a
      // styling correction (e.g. "the ring has a flat top, not fully
      // rounded"). Uses the item's current clean cutout as the reference —
      // the original uncropped photo is gone by the time an item is saved —
      // so this is only useful with an actual instruction, not a blank retry.
      const wardrobeRegenerateMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})\/regenerate$/i);
      if (wardrobeRegenerateMatch && req.method === "POST") {
        const id = wardrobeRegenerateMatch[1];
        const setup = await setupStatus();
        if (!setup.ready) return json(res, 503, { error: "Setup required: add your OpenAI API key first." });
        const records = await loadImported();
        const record = records.find((item) => item.id === id);
        if (!record) return json(res, 404, { error: "Wardrobe item not found." });
        const input = await body(req);
        const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 500) : "";
        if (!prompt) return json(res, 400, { error: "Describe what to change, e.g. \"the ring has a flat top, not fully rounded\"." });

        const garmentFile = path.join(libraryAssetDir, path.basename(new URL(record.image, "http://localhost").pathname));
        let currentImage;
        try {
          currentImage = await readFile(garmentFile);
        } catch (error) {
          console.error(`[wardrobe/regenerate] could not read ${garmentFile}:`, error);
          return json(res, 404, { error: "Could not read this item's current image." });
        }

        const key = setting("OPENAI_API_KEY");
        const chromaKeyUsed = chooseChromaKey(record.color);
        const basePrompt = buildGarmentPrompt(record, chromaKeyUsed);
        const fullPrompt = `${basePrompt}\nUser regeneration direction: ${prompt}`;
        const model = setting("OPENAI_GARMENT_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2"));
        const quality = setting("OPENAI_IMAGE_QUALITY", "high");
        try {
          let bytes = await openAIEdit({
            key,
            baseUrl: apiBaseUrl(),
            model,
            quality,
            size: "1024x1024",
            images: [{ data: currentImage, name: "current.png" }],
            prompt: fullPrompt,
          });
          bytes = await removeChromaBackground(bytes, chromaKeyUsed);
          await writeFile(garmentFile, bytes);
        } catch (error) {
          console.error(`[wardrobe/regenerate] OpenAI call failed (model=${model}, quality=${quality}) for ${id}:`, error);
          return json(res, 502, { error: error.message || "Could not regenerate that image." });
        }
        // Cache-bust: the file is served with a 1-year immutable cache header
        // and its filename never changes, so the client needs a new URL to
        // actually see the update. Persist that busted URL too, otherwise a
        // page refresh re-fetches the stale un-versioned URL from disk and
        // the browser serves the old cached bytes for it.
        const bustedImage = `${LIBRARY_ASSET_ROOT}/${path.basename(garmentFile)}?v=${Date.now()}`;
        const freshRecords = await loadImported();
        const nextRecords = freshRecords.map((item) => item.id === id ? { ...item, image: bustedImage, thumbnail: bustedImage } : item);
        await atomicJson(importedFile, nextRecords);
        return json(res, 200, { id, image: bustedImage });
      }
      const wardrobeDeleteMatch = url.pathname.match(/^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})$/i);
      if (wardrobeDeleteMatch && req.method === "DELETE") {
        const id = wardrobeDeleteMatch[1];
        const records = await loadImported();
        const next = records.filter((record) => record.id !== id);
        if (next.length === records.length) return json(res, 404, { error: "Imported wardrobe item not found" });
        await atomicJson(importedFile, next);
        await Promise.all([
          rm(path.join(libraryAssetDir, `${id}-garment.png`), { force: true }),
          rm(path.join(libraryAssetDir, `${id}-modeled.png`), { force: true }),
        ]);
        return json(res, 200, { deleted: true, id });
      }
      const libraryAssetMatch = url.pathname.match(/^\/api\/import\/library\/([\w.-]+)$/i);
      if (libraryAssetMatch && req.method === "GET") {
        const file = path.join(libraryAssetDir, path.basename(libraryAssetMatch[1]));
        await stat(file);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(await readFile(file));
      }
      const assetMatch = url.pathname.match(/^\/api\/import\/assets\/([a-f0-9-]{36})\/([\w.-]+)$/i);
      if (assetMatch && req.method === "GET") {
        const file = path.join(jobsDir, assetMatch[1], path.basename(assetMatch[2]));
        await stat(file);
        res.setHeader("Content-Type", file.endsWith(".svg") ? "image/svg+xml" : "image/png");
        res.setHeader("Cache-Control", "no-store");
        return res.end(await readFile(file));
      }
      // Shared by both direct uploads and "import from a link" — everything
      // downstream of "we have the raw image bytes" is identical.
      async function createJobsFromImageBytes(rawBytes, { singleItem = false } = {}) {
        const normalizedImage = await normalizeImage(rawBytes);
        const key = setting("OPENAI_API_KEY");
        const detected = (await openAIAnalyze({ key, baseUrl: apiBaseUrl(), model: setting("OPENAI_VISION_MODEL", "gpt-5.4-mini"), image: normalizedImage, mime: "image/png", singleItem })).map(normalizeMetadata);
        const jobs = [];
        for (const metadata of detected) {
          const id = randomUUID();
          const dir = path.join(jobsDir, id); await mkdir(dir, { recursive: true });
          const originalFile = "original.png";
          const cropFile = "crop.png";
          const croppedImage = await cropDetectedItem(normalizedImage, metadata.boundingBox);
          await writeFile(path.join(dir, originalFile), normalizedImage);
          await writeFile(path.join(dir, cropFile), croppedImage);
          const now = new Date().toISOString();
          const cropStage = { ...stageState(), status: "review", assetUrl: `${ASSET_ROOT}/${id}/${cropFile}`, updatedAt: now };
          // Modeled stage stays "skipped" by default — auto-generation was the
          // biggest token cost. Use the new Looks flow to compose an outfit on
          // demand instead. Users can still opt in via /stages/modeled/regenerate.
          const job = { id, status: "active", metadata, stages: { crop: cropStage, garment: stageState(), modeled: { ...stageState(), status: "skipped" } }, createdAt: now, updatedAt: now, internal: { originalFile, cropFile, originalMime: "image/png" } };
          job.originalAssetUrl = `${ASSET_ROOT}/${id}/${originalFile}`;
          await saveJob(job); jobs.push(publicJob(job));
        }
        return jobs;
      }

      if (url.pathname === API_ROOT && req.method === "POST") {
        const setup = await setupStatus();
        if (!setup.ready) {
          const missing = [
            !setup.hasApiKey && "OPENAI_API_KEY in .env",
            !setup.hasModelReference && `a PNG photo of yourself at ${setup.modelReference}`,
          ].filter(Boolean).join(" and ");
          return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
        }
        const input = await body(req);
        const image = decodeImage(input);
        const jobs = await createJobsFromImageBytes(image.data, { singleItem: Boolean(input.singleItem) });
        return json(res, 202, { jobs, noClothingDetected: jobs.length === 0 });
      }
      if (url.pathname === "/api/import/from-url" && req.method === "POST") {
        const setup = await setupStatus();
        if (!setup.ready) {
          return json(res, 503, { error: "Setup required: add your OpenAI API key and a model reference photo first." });
        }
        const input = await body(req);
        const pageUrl = typeof input.url === "string" ? input.url.trim() : "";
        if (!/^https?:\/\//i.test(pageUrl)) {
          return json(res, 400, { error: "Enter a valid product page link (starting with http:// or https://)." });
        }
        let imageUrl;
        try {
          imageUrl = await extractProductImageUrl(pageUrl);
        } catch (error) {
          console.error(`[import/from-url] could not find an image on ${pageUrl}:`, error);
          return json(res, 502, { error: error.message || "Could not find a product image on that page." });
        }
        let imageBytes;
        try {
          imageBytes = await downloadImage(imageUrl);
        } catch (error) {
          console.error(`[import/from-url] could not download ${imageUrl}:`, error);
          return json(res, 502, { error: error.message || "Could not download the image from that page." });
        }
        try {
          const jobs = await createJobsFromImageBytes(imageBytes, { singleItem: Boolean(input.singleItem) });
          return json(res, 202, { jobs, noClothingDetected: jobs.length === 0 });
        } catch (error) {
          console.error(`[import/from-url] job creation failed for ${pageUrl}:`, error);
          return json(res, 502, { error: error.message || "Could not process that image." });
        }
      }
      if (url.pathname === API_ROOT && req.method === "GET") {
        const ids = await readdir(jobsDir).catch(() => []);
        const loadedJobs = (await Promise.all(ids.map((id) => loadJob(id)))).filter(Boolean);
        const hiddenJobs = loadedJobs.filter((job) => job.status === "complete" || job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected");
        await Promise.all(hiddenJobs.map((job) => rm(path.join(jobsDir, job.id), { recursive: true, force: true })));
        const jobs = loadedJobs.filter((job) => !hiddenJobs.includes(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return json(res, 200, jobs.map(publicJob));
      }
      const match = url.pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/i);
      if (!match) return json(res, 404, { error: "Not found" });
      const job = await loadJob(match[1]);
      if (!job) return json(res, 404, { error: "Job not found" });
      const action = match[2] || "";
      if (!action && req.method === "GET") return json(res, 200, publicJob(job));
      if (!action && req.method === "DELETE") {
        await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        return json(res, 200, { deleted: true, id: job.id });
      }
      if (action === "metadata" && (req.method === "PATCH" || req.method === "PUT")) {
        const input = await body(req);
        if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) throw Object.assign(new Error("metadata must be an object"), { status: 400 });
        job.metadata = normalizeMetadata({ ...job.metadata, ...input.metadata }); await saveJob(job);
        return json(res, 200, publicJob(job));
      }
      const cleanupAction = action.match(/^stages\/garment\/(cleanup-preview|cleanup-accept)$/);
      if (cleanupAction && req.method === "POST") {
        const stage = job.stages.garment;
        if (stage.status !== "failed" || !stage.failedAssetUrl) {
          throw Object.assign(new Error("No failed garment source is available for cleanup"), { status: 409 });
        }
        const input = await body(req);
        const tolerance = cleanupTolerance(input.tolerance);
        const sourceName = path.basename(new URL(stage.failedAssetUrl, "http://localhost").pathname);
        const source = await readFile(path.join(jobsDir, job.id, sourceName));
        const key = stage.chromaKey || chooseChromaKey(job.metadata?.color);
        const cleaned = await processChromaBackground(source, key, { tolerance });
        const previewName = `garment-${stage.attempts}-cleanup-${tolerance}.png`;
        const previewUrl = `${ASSET_ROOT}/${job.id}/${previewName}`;
        await writeFile(path.join(jobsDir, job.id, previewName), cleaned.bytes);
        stage.chromaKey = key;
        stage.cleanupTolerance = cleaned.tolerance;
        stage.cleanupDiagnostics = cleaned.verification;
        stage.cleanupPreviewUrl = previewUrl;
        stage.updatedAt = new Date().toISOString();
        if (cleanupAction[1] === "cleanup-accept") {
          stage.status = "review";
          stage.decision = null;
          stage.error = null;
          stage.assetUrl = previewUrl;
        }
        await saveJob(job);
        return json(res, 200, publicJob(job));
      }
      const stageMatch = action.match(/^stages\/(crop|garment|modeled)\/(approve|reject|regenerate)$/);
      if (stageMatch && req.method === "POST") {
        const [, stageName, decision] = stageMatch;
        if (!STAGES.has(stageName)) throw Object.assign(new Error("Invalid stage"), { status: 400 });
        if (decision === "regenerate") {
          if (stageName === "crop") throw Object.assign(new Error("Upload the image again to create new crops"), { status: 400 });
          const input = await body(req);
          job.stages[stageName].prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) || null : null;
          job.stages[stageName].status = "queued";
          job.stages[stageName].decision = null;
          await saveJob(job);
          void generate(job, stageName);
          return json(res, 202, publicJob(job));
        }
        if (!DECISIONS.has(decision) || job.stages[stageName].status !== "review") throw Object.assign(new Error("Stage is not ready for review"), { status: 409 });
        const previousStatus = job.stages[stageName].status;
        const previousDecision = job.stages[stageName].decision;
        const previousJobStatus = job.status;
        job.stages[stageName].decision = decision === "approve" ? "approved" : "rejected";
        job.stages[stageName].status = job.stages[stageName].decision;
        job.stages[stageName].error = null;
        job.stages[stageName].updatedAt = new Date().toISOString();
        const startGarment = stageName === "crop" && decision === "approve" && job.stages.garment.status === "pending";
        // Auto-modeled preview removed to save tokens — approving the garment
        // finishes the import. Modeled generation is now on-demand via the
        // Looks flow (or manual /stages/modeled/regenerate).
        const startModeled = false;
        if (stageName === "garment" && decision === "approve") job.status = "complete";
        if (stageName === "modeled" && decision === "approve") job.status = "complete";
        await saveJob(job);
        if (decision === "approve" && stageName !== "crop") {
          try {
            // Include the modeled image only if the user later opts in and
            // approves it; garment-approval path skips modeled by design.
            await persistImported(job, stageName === "modeled" && job.stages.modeled?.assetUrl);
          } catch (error) {
            job.stages[stageName].status = previousStatus;
            job.stages[stageName].decision = previousDecision;
            job.status = previousJobStatus;
            await saveJob(job);
            throw error;
          }
        }
        if (decision === "reject") await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        if (startGarment) void generate(job, "garment");
        if (startModeled) void generate(job, "modeled");
        const response = publicJob(job);
        if (job.status === "complete") await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
        return json(res, 200, response);
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : error.status || 500;
      if (statusCode === 500) console.error(`[import-api] unhandled error on ${req.method} ${url.pathname}:`, error);
      return json(res, statusCode, { error: statusCode === 500 ? "Internal server error" : error.message, ...(process.env.NODE_ENV === "development" && statusCode === 500 ? { detail: error.message } : {}) });
    }
  }

  return {
    name: "wardrobe-import-job-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      const dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      jobsDir = path.join(dataDir, "jobs");
      importedFile = path.join(dataDir, "library.json");
      libraryAssetDir = path.join(dataDir, "imported");
      looksFile = path.join(dataDir, "looks.json");
      looksAssetDir = path.join(dataDir, "looks");
      await mkdir(jobsDir, { recursive: true });
      await mkdir(libraryAssetDir, { recursive: true });
      await mkdir(looksAssetDir, { recursive: true });
      const ids = await readdir(jobsDir).catch(() => []);
      for (const id of ids) {
        const job = await loadJob(id);
        if (!job) continue;
        if (job.status === "complete") {
          try {
            await persistImported(job, true);
            await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
          } catch (error) {
            job.status = "active";
            job.stages.modeled.status = "review";
            job.stages.modeled.decision = null;
            job.stages.modeled.error = null;
            await saveJob(job);
          }
          continue;
        }
        if (job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected") {
          await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
          continue;
        }
        if (job.stages.crop && job.stages.crop.status !== "approved") continue;
        if (["processing", "queued"].includes(job.stages.garment.status)) {
          job.stages.garment.status = "pending";
          await saveJob(job);
          void generate(job, "garment");
        } else if (job.stages.garment.status === "approved" && ["pending", "processing", "queued"].includes(job.stages.modeled.status)) {
          job.stages.modeled.status = "pending";
          await saveJob(job);
          void generate(job, "modeled");
        }
      }
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

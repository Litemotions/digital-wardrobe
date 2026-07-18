import type { VercelRequest, VercelResponse } from "@vercel/node";

// Serverless virtual try-on. Takes a photo of the person plus one or more
// garment photos and asks a Gemini image model to render the person wearing
// the outfit. The API key never leaves the server.
//
// Configure via environment variables:
//   GEMINI_API_KEY      (required)  your Google AI Studio key
//   GEMINI_IMAGE_MODEL  (optional)  defaults to gemini-2.5-flash-image

const DEFAULT_MODEL = "gemini-2.5-flash-image";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface InlineImage {
  mime: string;
  data: string; // base64, no data: prefix
}

interface Garment extends InlineImage {
  label: string;
}

interface TryOnBody {
  model: InlineImage;
  garments: Garment[];
  notes?: string;
}

export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" },
  },
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error: "Try-on engine is not configured yet.",
      hint: "Set the GEMINI_API_KEY environment variable (from Google AI Studio) on the server.",
    });
    return;
  }

  const body = req.body as TryOnBody | undefined;
  if (!body?.model?.data || !Array.isArray(body.garments) || body.garments.length === 0) {
    res.status(400).json({
      error: "Need a photo of you and at least one clothing item.",
    });
    return;
  }

  const model = process.env.GEMINI_IMAGE_MODEL || DEFAULT_MODEL;

  const garmentList = body.garments
    .map((g, i) => `${i + 1}. ${g.label}`)
    .join("\n");

  const prompt = [
    "You are a virtual try-on assistant.",
    "The FIRST image is a photo of a real person.",
    "The following images are individual clothing items to put on that person:",
    garmentList,
    "",
    "Generate ONE photorealistic image of the SAME person now wearing these",
    "items together as a complete outfit. Keep their face, hairstyle, body",
    "shape, skin tone, pose, and the background exactly the same. Replace only",
    "their clothing. Make the garments drape naturally with realistic fit,",
    "folds, lighting and shadows. Do not change the person's identity, and do",
    "not add text or watermarks.",
    body.notes ? `\nStyling notes from the user: ${body.notes}` : "",
  ].join("\n");

  const parts: any[] = [
    { text: prompt },
    { text: "Person:" },
    { inlineData: { mimeType: body.model.mime || "image/jpeg", data: body.model.data } },
  ];
  for (const g of body.garments) {
    parts.push({ text: g.label });
    parts.push({
      inlineData: { mimeType: g.mime || "image/jpeg", data: g.data },
    });
  }

  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  let geminiRes: Response;
  try {
    geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
      }),
    });
  } catch (err: any) {
    res.status(502).json({
      error: "Could not reach the image model.",
      hint: String(err?.message || err),
    });
    return;
  }

  const json: any = await geminiRes.json().catch(() => null);

  if (!geminiRes.ok) {
    const message =
      json?.error?.message || `Image model returned HTTP ${geminiRes.status}.`;
    res.status(502).json({
      error: "The image model rejected the request.",
      hint: message,
    });
    return;
  }

  const responseParts: any[] =
    json?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = responseParts.find(
    (p) => p?.inlineData?.data || p?.inline_data?.data
  );
  const inline = imagePart?.inlineData || imagePart?.inline_data;

  if (!inline?.data) {
    const text = responseParts
      .map((p) => p?.text)
      .filter(Boolean)
      .join(" ");
    res.status(502).json({
      error: "The model did not return an image.",
      text: text || undefined,
      hint: "Try a clearer, full-body photo of yourself, or fewer items at once.",
    });
    return;
  }

  res.status(200).json({
    image: {
      mime: inline.mimeType || inline.mime_type || "image/png",
      data: inline.data,
    },
  });
}

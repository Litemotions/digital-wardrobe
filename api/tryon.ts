import type { VercelRequest, VercelResponse } from "@vercel/node";

// Serverless virtual try-on. Takes a photo of the person plus one or more
// garment photos and asks an AI image model to render the person wearing the
// outfit. API keys never leave the server.
//
// Two providers are supported. The one used is chosen by TRYON_PROVIDER, or
// auto-detected: OpenAI if OPENAI_API_KEY is set, otherwise Gemini.
//
//   OpenAI  — set OPENAI_API_KEY   (model: gpt-image-1, override w/ OPENAI_IMAGE_MODEL)
//   Gemini  — set GEMINI_API_KEY   (model: gemini-2.5-flash-image, override w/ GEMINI_IMAGE_MODEL)
//   TRYON_PROVIDER          (optional)  "openai" | "gemini" to force one
//   OPENAI_IMAGE_QUALITY    (optional)  "low" | "medium" | "high" (default high)
//   OPENAI_IMAGE_SIZE       (optional)  e.g. 1024x1536 (portrait, default)

const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash-image";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_DEFAULT_MODEL = "gpt-image-1";
const OPENAI_EDITS_URL = "https://api.openai.com/v1/images/edits";

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

interface EngineResult {
  mime: string;
  data: string; // base64
}

class EngineError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
    readonly text?: string
  ) {
    super(message);
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: "10mb" },
  },
};

function buildPrompt(body: TryOnBody): string {
  const garmentList = body.garments
    .map((g, i) => `${i + 1}. ${g.label}`)
    .join("\n");
  return [
    "You are a virtual try-on assistant.",
    "The FIRST image is a photo of a real person.",
    "The remaining images are individual clothing items to put on that person:",
    garmentList,
    "",
    "Generate ONE photorealistic image of the SAME person now wearing these",
    "items together as a complete outfit.",
    "",
    "CRITICAL: the person's face and identity must stay EXACTLY as in the first",
    "photo — the same facial features, bone structure, skin tone, hair and",
    "expression. Do NOT change, beautify, stylize, or swap the face. The result",
    "must be unmistakably the same person. Also keep their body shape and pose.",
    "",
    "Replace only their clothing. Make the garments drape naturally with",
    "realistic fit, folds, lighting and shadows. Do not add text or watermarks.",
    body.notes ? `\nStyling notes from the user: ${body.notes}` : "",
  ].join("\n");
}

function friendlyBillingHint(message: string): string | undefined {
  const m = message.toLowerCase();
  if (
    m.includes("quota") ||
    m.includes("billing") ||
    m.includes("insufficient_quota") ||
    m.includes("exceeded your current")
  ) {
    return "This usually means billing isn't enabled (or is exhausted) on your API key's account. Check your plan/billing and try again.";
  }
  return undefined;
}

// --- OpenAI (gpt-image-1 image edits) ---------------------------------
async function runOpenAI(
  apiKey: string,
  body: TryOnBody
): Promise<EngineResult> {
  const model = process.env.OPENAI_IMAGE_MODEL || OPENAI_DEFAULT_MODEL;
  const quality = process.env.OPENAI_IMAGE_QUALITY || "high";
  const size = process.env.OPENAI_IMAGE_SIZE || "1024x1536";

  const form = new FormData();
  form.append("model", model);
  form.append("prompt", buildPrompt(body));
  form.append("n", "1");
  form.append("size", size);
  form.append("quality", quality);
  // Preserve fine detail from the input photo (notably the face) so the
  // result actually looks like the person.
  form.append(
    "input_fidelity",
    process.env.OPENAI_INPUT_FIDELITY || "high"
  );

  const person = Buffer.from(body.model.data, "base64");
  form.append(
    "image[]",
    new Blob([person], { type: body.model.mime || "image/png" }),
    "person.png"
  );
  body.garments.forEach((g, i) => {
    const buf = Buffer.from(g.data, "base64");
    form.append(
      "image[]",
      new Blob([buf], { type: g.mime || "image/png" }),
      `garment-${i + 1}.png`
    );
  });

  let res: Response;
  try {
    res = await fetch(OPENAI_EDITS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err: any) {
    throw new EngineError(502, "Could not reach OpenAI.", String(err?.message || err));
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const message = json?.error?.message || `OpenAI returned HTTP ${res.status}.`;
    throw new EngineError(502, "The image model rejected the request.", friendlyBillingHint(message) || message);
  }

  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    throw new EngineError(
      502,
      "OpenAI did not return an image.",
      "Try a clearer, full-body photo, or fewer items at once."
    );
  }
  return { mime: "image/png", data: b64 };
}

// --- Gemini (2.5 Flash Image) -----------------------------------------
async function runGemini(
  apiKey: string,
  body: TryOnBody
): Promise<EngineResult> {
  const model = process.env.GEMINI_IMAGE_MODEL || GEMINI_DEFAULT_MODEL;

  const parts: any[] = [
    { text: buildPrompt(body) },
    { text: "Person:" },
    {
      inlineData: {
        mimeType: body.model.mime || "image/jpeg",
        data: body.model.data,
      },
    },
  ];
  for (const g of body.garments) {
    parts.push({ text: g.label });
    parts.push({
      inlineData: { mimeType: g.mime || "image/jpeg", data: g.data },
    });
  }

  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(
    model
  )}:generateContent?key=${apiKey}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
      }),
    });
  } catch (err: any) {
    throw new EngineError(502, "Could not reach the image model.", String(err?.message || err));
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      json?.error?.message || `Image model returned HTTP ${res.status}.`;
    throw new EngineError(502, "The image model rejected the request.", friendlyBillingHint(message) || message);
  }

  const responseParts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = responseParts.find(
    (p) => p?.inlineData?.data || p?.inline_data?.data
  );
  const inline = imagePart?.inlineData || imagePart?.inline_data;
  if (!inline?.data) {
    const text = responseParts
      .map((p) => p?.text)
      .filter(Boolean)
      .join(" ");
    throw new EngineError(
      502,
      "The model did not return an image.",
      "Try a clearer, full-body photo of yourself, or fewer items at once.",
      text || undefined
    );
  }
  return {
    mime: inline.mimeType || inline.mime_type || "image/png",
    data: inline.data,
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const provider =
    process.env.TRYON_PROVIDER?.toLowerCase() ||
    (openaiKey ? "openai" : geminiKey ? "gemini" : "");

  if (!provider) {
    res.status(503).json({
      error: "Try-on engine is not configured yet.",
      hint: "Set OPENAI_API_KEY (or GEMINI_API_KEY) as an environment variable on the server.",
    });
    return;
  }

  const body = req.body as TryOnBody | undefined;
  if (
    !body?.model?.data ||
    !Array.isArray(body.garments) ||
    body.garments.length === 0
  ) {
    res.status(400).json({
      error: "Need a photo of you and at least one clothing item.",
    });
    return;
  }

  try {
    let result: EngineResult;
    if (provider === "openai") {
      if (!openaiKey)
        throw new EngineError(503, "OPENAI_API_KEY is not set on the server.");
      result = await runOpenAI(openaiKey, body);
    } else if (provider === "gemini") {
      if (!geminiKey)
        throw new EngineError(503, "GEMINI_API_KEY is not set on the server.");
      result = await runGemini(geminiKey, body);
    } else {
      throw new EngineError(400, `Unknown TRYON_PROVIDER "${provider}".`);
    }
    res.status(200).json({ image: result });
  } catch (err) {
    if (err instanceof EngineError) {
      res.status(err.status).json({
        error: err.message,
        hint: err.hint,
        text: err.text,
      });
      return;
    }
    res.status(500).json({ error: "Unexpected error generating the look." });
  }
}

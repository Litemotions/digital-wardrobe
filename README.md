# 👗 Digital Wardrobe

Upload photos of your clothes, mix & match them into outfits, and — the fun part —
see the outfit **rendered onto a photo of you** with AI virtual try-on. It's a
digital wardrobe that actually shows you what things look like *worn*, not just
laid flat.

## Features

- **Your wardrobe, on your device** — snap or upload photos of individual
  clothing items, tag them by category (tops, bottoms, dresses, outerwear,
  shoes, accessories) and color. Everything is stored locally in your browser
  (IndexedDB). No accounts, no uploads to a database.
- **Photos of you** — add one or more full-body photos and pick the active one.
- **Style studio** — mix & match pieces (one per slot, plus accessories), add
  optional styling notes, and hit **Try it on me**.
- **AI try-on** — a serverless function sends your photo + the selected garments
  to a Gemini image model, which returns a photorealistic image of *you* wearing
  the outfit, keeping your face, pose and background.
- **Lookbook** — save the looks you like and download them.

## How it works

| Layer | Tech |
| --- | --- |
| Frontend | Vite + React + TypeScript |
| Storage | IndexedDB (via `idb`) — stays on your device |
| Try-on | `/api/tryon` serverless function → OpenAI `gpt-image-1` or Google Gemini 2.5 Flash Image |

The try-on function supports two providers and auto-selects **OpenAI** if
`OPENAI_API_KEY` is set, otherwise **Gemini**. Set `TRYON_PROVIDER` to force one.
Only the try-on request leaves your device, and it goes straight to the image
model. Your API key lives on the server, never in the browser.

## Getting started

```bash
npm install
```

You need an image-model API key for the try-on feature — either an **OpenAI**
key (<https://platform.openai.com/api-keys>, billing enabled) or a **Google AI
Studio** key (<https://aistudio.google.com/apikey>, billing enabled — image
generation isn't in the free tier). See `.env.example` for all options.

### Run locally

The UI runs with Vite, but the `/api/tryon` function needs a serverless runtime.
The simplest path is the Vercel CLI, which runs both together:

```bash
npm i -g vercel
cp .env.example .env.local     # then paste your GEMINI_API_KEY
vercel dev                     # serves the app + /api on http://localhost:3000
```

You can also run just the UI with `npm run dev` (Vite proxies `/api` to
`localhost:3000`, so start `vercel dev` alongside it if you want try-on to work).

### Deploy

Deploy to [Vercel](https://vercel.com):

1. Import this repo.
2. Add an environment variable **`OPENAI_API_KEY`** (or **`GEMINI_API_KEY`**).
3. Deploy. The Vite frontend and the `/api/tryon` function ship together.

See `.env.example` for optional overrides (model, quality, size, provider).

## Tips for good try-on results

- Use a clear, well-lit, **full-body** photo, standing straight, plain
  background.
- Photograph clothing items flat or on a hanger against a plain background.
- Fewer items at once (a top + bottom + shoes) tends to render more reliably
  than a dozen pieces.

## Privacy

Your wardrobe and photos never leave your device except when you press
**Try it on me**, which sends the active photo and the selected garments to the
image model to render the result. Clearing your browser's site data removes
everything.

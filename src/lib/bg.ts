// On-device background removal. The model (WASM) is fetched lazily the first
// time it's used, so it doesn't bloat initial page load. Runs entirely in the
// browser — the photo is never uploaded for this step.
export async function cutOutBackground(input: Blob): Promise<Blob> {
  const { removeBackground } = await import("@imgly/background-removal");
  const out = await removeBackground(input, {
    output: { format: "image/png", quality: 0.9 },
  });
  return out;
}

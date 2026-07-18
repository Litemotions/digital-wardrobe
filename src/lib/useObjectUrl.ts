import { useEffect, useState } from "react";

// Turn a Blob into an object URL that is revoked when the blob changes or the
// component unmounts, so we don't leak memory as the wardrobe grows.
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

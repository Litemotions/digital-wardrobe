import { useEffect, useState } from "react";
import type { ImageSrc } from "../types";

// Turn an image source into a URL usable in <img src>. A Blob becomes an object
// URL that is revoked on change/unmount; a string (already a URL) is passed
// through as-is.
export function useObjectUrl(src: ImageSrc | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(
    typeof src === "string" ? src : null
  );
  useEffect(() => {
    if (!src) {
      setUrl(null);
      return;
    }
    if (typeof src === "string") {
      setUrl(src);
      return;
    }
    const next = URL.createObjectURL(src);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [src]);
  return url;
}

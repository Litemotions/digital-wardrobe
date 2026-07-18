import { useObjectUrl } from "../lib/useObjectUrl";
import type { ImageSrc } from "../types";

export function Thumb({
  blob,
  alt,
  className = "thumb",
}: {
  blob: ImageSrc;
  alt: string;
  className?: string;
}) {
  const url = useObjectUrl(blob);
  if (!url) return <div className={className} />;
  return <img className={className} src={url} alt={alt} />;
}

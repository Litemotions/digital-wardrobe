import { useObjectUrl } from "../lib/useObjectUrl";

export function Thumb({
  blob,
  alt,
  className = "thumb",
}: {
  blob: Blob;
  alt: string;
  className?: string;
}) {
  const url = useObjectUrl(blob);
  if (!url) return <div className={className} />;
  return <img className={className} src={url} alt={alt} />;
}

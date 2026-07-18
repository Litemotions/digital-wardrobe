import { useRef, type ReactNode } from "react";

export function UploadButton({
  onFile,
  className = "btn primary",
  children,
  capture,
}: {
  onFile: (file: File) => void;
  className?: string;
  children: ReactNode;
  capture?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className={className} onClick={() => ref.current?.click()}>
        {children}
      </button>
      <input
        ref={ref}
        className="hidden-input"
        type="file"
        accept="image/*"
        {...(capture ? { capture: "environment" as any } : {})}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </>
  );
}

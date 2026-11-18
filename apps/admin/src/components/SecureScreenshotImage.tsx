import { useCallback, useEffect, useRef, useState } from "react";
import { ImageOff, RefreshCw } from "lucide-react";
import { adminApi, apiFetchBlob } from "../lib/api";

interface SecureScreenshotImageProps {
  screenshotId: number;
  imageEndpoint: string;
  presignedUrl: string | null;
  presignedUrlExpiresAt?: string | null;
  alt: string;
  aspectClassName?: string;
  imgClassName?: string;
  containerBgClassName?: string;
  loading?: "lazy" | "eager";
  imgDraggable?: boolean;
}

function isNearExpiry(expiresAt?: string | null): boolean {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return false;
  return ms - Date.now() < 30_000;
}

export function SecureScreenshotImage({
  screenshotId,
  imageEndpoint,
  presignedUrl,
  presignedUrlExpiresAt,
  alt,
  aspectClassName = "aspect-video",
  imgClassName = "h-full w-full object-cover",
  containerBgClassName = "bg-slate-200",
  loading = "lazy",
  imgDraggable = true,
}: SecureScreenshotImageProps) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(() => {
    if (presignedUrl && !isNearExpiry(presignedUrlExpiresAt)) {
      return presignedUrl;
    }
    return null;
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasError, setHasError] = useState<boolean>(false);
  const [retryToken, setRetryToken] = useState<number>(0);

  const objectUrlRef = useRef<string | null>(null);
  const refreshedR2OnceRef = useRef<boolean>(false);

  const revokeCurrentObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    refreshedR2OnceRef.current = false;
    setHasError(false);

    async function resolveSource() {
      revokeCurrentObjectUrl();

      // R2 presigned URL path
      if (presignedUrl !== null) {
        if (!isNearExpiry(presignedUrlExpiresAt) && retryToken === 0) {
          setResolvedSrc(presignedUrl);
          setIsLoading(true);
          return;
        }

        try {
          setIsLoading(true);
          const fresh = await adminApi.getPresignedScreenshotUrl(imageEndpoint);
          if (!active) return;
          setResolvedSrc(fresh.url);
        } catch {
          if (!active) return;
          setResolvedSrc(null);
          setIsLoading(false);
          setHasError(true);
        }
        return;
      }

      // Local Disk authenticated stream -> Blob -> ObjectURL
      try {
        setIsLoading(true);
        setResolvedSrc(null);
        const blob = await apiFetchBlob(imageEndpoint, controller.signal);
        if (!active) return;
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        setResolvedSrc(url);
      } catch (err) {
        if (!active) return;
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setResolvedSrc(null);
        setIsLoading(false);
        setHasError(true);
      }
    }

    void resolveSource();

    return () => {
      active = false;
      controller.abort();
      revokeCurrentObjectUrl();
    };
  }, [
    screenshotId,
    imageEndpoint,
    presignedUrl,
    presignedUrlExpiresAt,
    retryToken,
    revokeCurrentObjectUrl,
  ]);

  const handleImgError = useCallback(async () => {
    // If R2 presigned URL expired mid-session, attempt one ?delivery=json refresh
    if (presignedUrl !== null && !refreshedR2OnceRef.current) {
      refreshedR2OnceRef.current = true;
      try {
        const fresh = await adminApi.getPresignedScreenshotUrl(imageEndpoint);
        setResolvedSrc(fresh.url);
        setHasError(false);
        setIsLoading(true);
        return;
      } catch {
        // fall through to error state
      }
    }
    setIsLoading(false);
    setHasError(true);
  }, [imageEndpoint, presignedUrl]);

  const handleRetry = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setHasError(false);
      setIsLoading(true);
      setRetryToken((n) => n + 1);
    },
    []
  );

  return (
    <div
      className={`relative w-full overflow-hidden ${containerBgClassName} ${aspectClassName}`}
    >
      {isLoading && !hasError ? (
        <div
          className="absolute inset-0 animate-pulse bg-slate-200"
          aria-hidden="true"
        />
      ) : null}

      {hasError ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-slate-100 p-3 text-center">
          <ImageOff
            className="h-5 w-5 text-slate-500"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <button
            type="button"
            onClick={handleRetry}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Preview unavailable — Retry
          </button>
        </div>
      ) : resolvedSrc ? (
        <img
          src={resolvedSrc}
          alt={alt}
          loading={loading}
          decoding="async"
          draggable={imgDraggable}
          onLoad={() => setIsLoading(false)}
          onError={() => void handleImgError()}
          className={`${imgClassName} transition-opacity duration-150 ${
            isLoading ? "opacity-0" : "opacity-100"
          }`}
        />
      ) : null}
    </div>
  );
}

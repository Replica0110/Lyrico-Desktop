import { useEffect, useState } from "react";
import { fetchRemoteImage } from "../backend/audioApi";

// All remote artwork crosses the backend's bounded, public-address-only image proxy.
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
function load(url: string, maxSize?: number) {
  const key = `${maxSize ?? "original"}:${url}`;
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  let request = pending.get(key);
  if (!request) {
    request = fetchRemoteImage(url, maxSize).then((dataUrl) => {
      cache.set(key, dataUrl);
      while (cache.size > 128) cache.delete(cache.keys().next().value!);
      return dataUrl;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}
export function useRemoteImage(url?: string, maxSize?: number) {
  const key = `${maxSize ?? "original"}:${url ?? ""}`;
  const [result, setResult] = useState<{ key: string; dataUrl?: string; error?: string }>({ key: "" });
  useEffect(() => {
    if (!url) return;
    let disposed = false;
    void load(url, maxSize).then(
      (dataUrl) => { if (!disposed) setResult({ key, dataUrl }); },
      (error) => { if (!disposed) setResult({ key, error: String(error) }); },
    );
    return () => { disposed = true; };
  }, [url, maxSize, key]);
  return result.key === key ? result : { key };
}

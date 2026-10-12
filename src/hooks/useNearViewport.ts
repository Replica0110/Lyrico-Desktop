import { useEffect, useRef, useState } from "react";

export function useNearViewport(identity: string, enabled = true) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visibleIdentity, setVisibleIdentity] = useState<string>();
  useEffect(() => {
    setVisibleIdentity(undefined);
    const element = ref.current;
    if (!enabled || !element) return;
    if (typeof IntersectionObserver === "undefined") { setVisibleIdentity(identity); return; }
    const observer = new IntersectionObserver(([entry]) => {
      setVisibleIdentity(entry.isIntersecting ? identity : undefined);
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [identity, enabled]);
  return { ref, nearViewport: enabled && visibleIdentity === identity };
}

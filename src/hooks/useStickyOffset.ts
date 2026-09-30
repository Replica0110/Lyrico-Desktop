import { useLayoutEffect, useState, type RefObject } from "react";

export function useStickyOffset(ref: RefObject<HTMLElement | null>) {
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setOffset(Math.round(element.getBoundingClientRect().height));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return offset;
}

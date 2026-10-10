import { useEffect, useRef } from "react";

const GUARD = { lyricoGuard: true };

function hasGuard() {
  return Boolean(history.state && (history.state as { lyricoGuard?: boolean }).lyricoGuard);
}

/** Windows WebView2 treats the side button as history back. One extra history entry keeps the window from going blank. */
export function useBlockMouseSideButtons() {
  useEffect(() => {
    if (!hasGuard()) history.pushState(GUARD, "");
    const keepGuard = () => {
      if (!hasGuard()) history.pushState(GUARD, "");
    };
    window.addEventListener("popstate", keepGuard);
    return () => window.removeEventListener("popstate", keepGuard);
  }, []);
}

function dialogIsOpen() {
  return [...document.querySelectorAll<HTMLElement>(".ant-modal-wrap")].some((wrap) => {
    const style = window.getComputedStyle(wrap);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

/** Side-button back moves up one level. The forward button does not keep a history entry. */
export function useGoUpOnMouseBack(enabled: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    if (!enabled) return;
    const onPop = () => {
      if (dialogIsOpen()) return;
      onBackRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [enabled]);
}

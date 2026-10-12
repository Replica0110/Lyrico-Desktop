import { useEffect, useRef } from "react";

const GUARD = { lyricoGuard: true };
const BACK_EVENT = "lyrico:navigate-back";

function hasGuard() {
  return Boolean(history.state && (history.state as { lyricoGuard?: boolean }).lyricoGuard);
}

/** Windows WebView2 treats the side button as history back. One extra history entry keeps the window from going blank. */
export function useBlockMouseSideButtons() {
  useEffect(() => {
    if (!hasGuard()) history.pushState(GUARD, "");
    const keepGuard = (event: PopStateEvent) => {
      // A forward navigation to the guard must not also move up a level.
      if (event.state?.lyricoGuard) return;
      if (!hasGuard()) history.pushState(GUARD, "");
      if (!dialogIsOpen()) window.dispatchEvent(new Event(BACK_EVENT, { cancelable: true }));
    };
    window.addEventListener("popstate", keepGuard);
    return () => window.removeEventListener("popstate", keepGuard);
  }, []);
}

function dialogIsOpen() {
  return [...document.querySelectorAll<HTMLElement>(".ant-modal-wrap, .ant-drawer")].some((wrap) => {
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
    const onPop = (event: Event) => {
      if (event.defaultPrevented || dialogIsOpen()) return;
      event.preventDefault();
      onBackRef.current();
    };
    window.addEventListener(BACK_EVENT, onPop);
    return () => window.removeEventListener(BACK_EVENT, onPop);
  }, [enabled]);
}

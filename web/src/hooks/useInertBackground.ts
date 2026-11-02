import { useEffect } from "react";

/** Radix hides modal siblings from assistive technology. Also make those
 * siblings inert so their controls cannot receive programmatic or Tab focus.
 * Only restore inert attributes owned by this hook; nested portals stay usable.
 */
export function useInertBackground() {
  useEffect(() => {
    const owned = new Set<HTMLElement>();
    const sync = () => {
      for (const element of owned) {
        if (!element.isConnected || element.getAttribute("data-aria-hidden") !== "true" || element.getAttribute("aria-hidden") !== "true") {
          element.inert = false;
          owned.delete(element);
        }
      }
      document.querySelectorAll<HTMLElement>('[data-aria-hidden="true"][aria-hidden="true"]').forEach(element => {
        if (!element.inert) {
          element.inert = true;
          owned.add(element);
        }
      });
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-aria-hidden", "aria-hidden"] });
    sync();
    return () => { observer.disconnect(); owned.forEach(element => { element.inert = false; }); };
  }, []);
}

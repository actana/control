import { useEffect } from "react";

// Locks are counted: a Session screen and a user terminal screen can both be
// mounted, and the page must stay locked until the last one goes.
let locks = 0;
let saved = "";

/** Keep the page behind a full-screen overlay from scrolling while `active`. */
export function useBodyScrollLock(active = true) {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    if (locks === 0) {
      saved = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    locks += 1;
    return () => {
      locks -= 1;
      if (locks === 0) document.body.style.overflow = saved;
    };
  }, [active]);
}

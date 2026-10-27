import { useEffect, useState } from "react";

export type VisualViewportBox = { height: number | null; offsetTop: number };

function read(): VisualViewportBox {
  const vv = typeof window === "undefined" ? undefined : window.visualViewport;
  return vv ? { height: vv.height, offsetTop: vv.offsetTop } : { height: null, offsetTop: 0 };
}

/** The visible area of the page; shrinks when a mobile on-screen keyboard opens. `height` is null without the API. */
export function useVisualViewport(): VisualViewportBox {
  const [box, setBox] = useState(read);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const next = read();
      setBox((prev) => (prev.height === next.height && prev.offsetTop === next.offsetTop ? prev : next));
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return box;
}

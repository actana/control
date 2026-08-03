import { forwardRef, useCallback, type CSSProperties, type HTMLAttributes, type Ref } from "react";
import { useCardGlow } from "~/lib/use-card-glow";

type CardFrameProps = HTMLAttributes<HTMLElement> & {
  as?: "div" | "aside" | "nav" | "section";
  glow?: boolean;
  focused?: boolean;
  solid?: boolean;
};

// The visual treatment (surface, hairline, radius, focus ring) lives entirely
// in the `.mc-card-frame` rules in styles.css — this component only carries
// layout-neutral structure and the data attributes those rules key off.
const frameBaseStyle: CSSProperties = {
  boxSizing: "border-box",
  overflow: "hidden",
  position: "relative",
};

export const CardFrame = forwardRef<HTMLElement, CardFrameProps>(function CardFrame(
  { as: Component = "div", glow = false, focused = false, solid = false, style, className, ...props },
  forwardedRef
) {
  const glowRef = useCardGlow<HTMLElement>();
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      glowRef(glow ? node : null);
      assignRef(forwardedRef, node);
    },
    [forwardedRef, glow, glowRef]
  );
  const mergedClassName = ["mc-card-frame", className].filter(Boolean).join(" ");

  return (
    <Component
      {...props}
      ref={setRef}
      className={mergedClassName}
      data-focused={focused ? "true" : undefined}
      data-solid={solid ? "true" : undefined}
      style={{
        ...frameBaseStyle,
        ...style,
      }}
    />
  );
});

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
  } else {
    ref.current = value;
  }
}

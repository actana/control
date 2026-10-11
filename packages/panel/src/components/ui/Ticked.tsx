/**
 * Prose with `backticked` runs rendered as code.
 *
 * The onboarding strings are written once and read by a person, and the two
 * values in this one — a command and an address — are things to be typed
 * exactly. Marking them in the string keeps the copy in
 * `core-onboarding.ts`, where a test can read it, rather than splitting one
 * sentence across three JSX children.
 */
export function Ticked({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((piece, index) =>
        index % 2 === 1 ? (
          <code key={index} style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>
            {piece}
          </code>
        ) : (
          <span key={index}>{piece}</span>
        ),
      )}
    </>
  );
}

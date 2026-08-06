import { useEffect, useState } from "react";
import { Banner } from "~/components/ui/Banner";
import { PANEL_UPDATE_COMMAND } from "~/shared/cores";
import { dismissUpdate, readDismissedUpdate } from "~/lib/update-banner-dismissal";
import { useUpdateCheck } from "~/queries";

// "A newer Actana exists" — the one thing this Panel has to say about its own
// version, and the only thing it will ever do about it.
//
// There is no button here and there will not be one. The Panel is a service its
// operator deploys, not an app that rewrites itself (ADR 0010), so the remedy
// is a command on the host — the Panel ships as a container, which makes that
// command the same two words for every deployment.
//
// Silence is the default. No banner while the check is loading, none when the
// release channel could not be read (which is the ordinary case until 0.1.0 is
// published), none when this Panel is current, and none once the operator has
// dismissed this particular release.

export function UpdateBanner() {
  const { data } = useUpdateCheck();
  const [dismissed, setDismissed] = useState<string | null>(null);

  // Read after mount, not during render: this component renders inside the
  // shell's ClientOnly boundary, but a localStorage read in a render body is
  // still the kind of thing that breaks the moment it moves.
  useEffect(() => setDismissed(readDismissedUpdate()), []);

  const latest = data?.updateAvailable ? data.latest : null;
  if (!latest || dismissed === latest) return null;

  return (
    <Banner
      variant="info"
      onDismiss={() => {
        dismissUpdate(latest);
        setDismissed(latest);
      }}
    >
      Actana {latest} is available — you&apos;re on {data?.current}. To update this Panel, run{" "}
      <code style={{ fontFamily: "var(--mono)" }}>{PANEL_UPDATE_COMMAND}</code> where it is
      deployed.
    </Banner>
  );
}

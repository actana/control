import { Btn } from "~/components/ui/Btn";

/**
 * The "Load more" that ends a paged list, the same one the Tasks board uses.
 * Renders nothing unless there is another page; `compact` makes it a 44px tap
 * target like the other actions on a phone.
 */
export function LoadMoreButton({
  hasMore,
  loading,
  onClick,
  compact = false,
}: {
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  if (!hasMore) return null;
  return (
    <Btn
      variant="ghost"
      size="sm"
      data-load-more
      disabled={loading}
      style={compact ? { minHeight: 44 } : undefined}
      onClick={onClick}
    >
      {loading ? "Loading…" : "Load more"}
    </Btn>
  );
}

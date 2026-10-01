// The icon vocabulary lives in `@actana/shared/session-icons` as the single
// source of truth — the title generator that picks from it runs on the Core
// (issue 84), while the cell that renders the choice runs in the Panel.
// Re-exported here to preserve existing import paths.
export {
  SESSION_ICON_OPTIONS,
  DEFAULT_SESSION_ICON,
  isSessionIcon,
} from "@actana/shared/session-icons";

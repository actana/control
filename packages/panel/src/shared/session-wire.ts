// The wire shape of the public Session list (#960): lean rows, never a prompt
// or a transcript. Shared by `GET /api/v1/sessions` and the `get_sessions` tool.

export type SessionListItemDto = {
  id: string;
  title: string;
  harness: string;
  status: string;
  pinned: boolean;
  archived: boolean;
  /** True while the Core holds a live terminal for the Session. */
  live: boolean;
  updatedAt: number;
};

export type SessionsPageDto = {
  sessions: SessionListItemDto[];
  /** Pass it back as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
  /** How many Sessions match the filters on this Core, not just this page. */
  total: number;
};

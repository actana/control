-- Panel-local presentation for projects the Panel does not own (issue 98).
--
-- A Core-owned Project's row lives on its Core. Group membership, the card
-- image and the launch URL are the Panel operator's own filing, mean nothing on
-- the Core, and have no core-link frame to travel in — so they live here and are
-- joined onto the Core's snapshot on read. Keyed by project id alone (ids are
-- minted `p-<base36 ms>-<6 hex>`); `core_id` rides along for orphan sweeps.
-- Deliberately no foreign key to `projects`: the point is a row with no project row.
CREATE TABLE IF NOT EXISTS project_presentation (
  project_id TEXT PRIMARY KEY,
  core_id TEXT NOT NULL,
  image_path TEXT,
  group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  launch_url TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_presentation_core_idx ON project_presentation(core_id);
CREATE INDEX IF NOT EXISTS project_presentation_group_idx ON project_presentation(group_id);

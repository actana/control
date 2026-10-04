import { useEffect, useState } from "react";
import { Btn } from "~/components/ui/Btn";
import { FormErrorBox } from "~/components/ui/FormErrorBox";
import { Modal } from "~/components/ui/Modal";
import { TextField } from "~/components/ui/TextField";
import { FilesTree } from "~/components/views/FilesTree";
import { checkEntryName, displayPath, parentOf } from "~/shared/shared-files";

/** The Files tab's small dialogs (#565): a name (new folder, new text file, rename) and the folder picker of Move. */

export function NameDialog({
  open,
  title,
  label,
  initial,
  confirmLabel,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValue(initial);
      setError(null);
    }
  }, [open, initial]);

  const submit = async () => {
    const checked = checkEntryName(value);
    if (!checked.ok) return setError(checked.reason);
    setBusy(true);
    try {
      await onSubmit(checked.name);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={420}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={busy || !value.trim()} onClick={() => void submit()}>{confirmLabel}</Btn>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        <TextField label={label} value={value} onChange={setValue} autoFocus mono />
        <FormErrorBox error={error} />
      </form>
    </Modal>
  );
}

/** Pick a folder over the same tree as the sidebar. A folder cannot go into itself, so it and what is in it are not offered. */
export function MoveDialog({
  open,
  coreId,
  path,
  isFolder,
  onClose,
  onMove,
}: {
  open: boolean;
  coreId: string;
  path: string;
  isFolder: boolean;
  onClose: () => void;
  onMove: (toFolder: string) => Promise<void>;
}) {
  const [target, setTarget] = useState(parentOf(path));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setTarget(parentOf(path));
      setError(null);
    }
  }, [open, path]);
  const unchanged = target === parentOf(path);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Move ${displayPath(path)}`}
      width={460}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn
            variant="primary"
            disabled={busy || unchanged}
            onClick={() => {
              setBusy(true);
              onMove(target)
                .then(onClose, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
          >
            Move here
          </Btn>
        </>
      }
    >
      <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 6 }}>
        <FilesTree coreId={coreId} current={target} onOpen={setTarget} hidden={isFolder ? [path.replace(/\/+$/, "")] : []} poll={false} />
      </div>
      <p style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)" }}>To: {displayPath(target)}</p>
      <FormErrorBox error={error} />
    </Modal>
  );
}

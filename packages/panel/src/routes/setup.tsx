import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { AuthCard } from "~/components/views/AuthCard";
import { TextField } from "~/components/ui/TextField";
import { api, ApiError } from "~/lib/api";
import { MIN_PASSWORD_LENGTH } from "~/shared/operator-password";

// First boot: the Panel serves this page, and only this page, until the single
// Operator exists. There is no window in which the service is reachable and
// unprotected.
export const Route = createFileRoute("/setup")({
  component: SetupPage,
});

function SetupPage() {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("the two passwords don't match");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setupOperator({ name, password });
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "setup failed");
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Set up your Panel"
      subtitle="Choose the password you'll use to reach this Panel from any browser. It's stored only as a hash, and there is no recovery — keep it somewhere safe."
      error={error}
      submitLabel="Create Operator"
      busy={busy}
      onSubmit={submit}
    >
      <TextField
        label="Your name"
        autoComplete="nickname"
        placeholder="Operator"
        autoFocus
        value={name}
        onChange={setName}
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        required
        value={password}
        onChange={setPassword}
      />
      <TextField
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={setConfirm}
      />
    </AuthCard>
  );
}

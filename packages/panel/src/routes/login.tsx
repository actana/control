import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { AuthCard } from "~/components/views/AuthCard";
import { TextField } from "~/components/ui/TextField";
import { api, ApiError } from "~/lib/api";

// The Panel's only anonymous page once an Operator exists. Reached by every
// unauthenticated navigation (server/panel-auth.ts:documentAuthRedirect).
export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      // A full load rather than a client navigation: the app shell mounts
      // outside this page's tree, and SSR should render it with the new cookie.
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "sign-in failed");
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Sign in"
      subtitle="This Panel is protected by your Operator password."
      error={error}
      submitLabel="Sign in"
      busy={busy}
      onSubmit={submit}
    >
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        autoFocus
        required
        value={password}
        onChange={setPassword}
      />
    </AuthCard>
  );
}

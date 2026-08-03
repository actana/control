import { useEffect, useState, type FormEvent } from "react";
import { Btn } from "~/components/ui/Btn";
import { Field, SettingsSection } from "~/components/views/SettingsParts";
import { TextField } from "~/components/ui/TextField";
import { api, ApiError, type AuthStateResponse } from "~/lib/api";
import { toast } from "sonner";
import { MIN_PASSWORD_LENGTH } from "~/shared/operator-password";

/**
 * The Operator's own account: who this Panel belongs to, changing the password
 * (which signs every browser out), and signing out of this one.
 */
export function OperatorSettingsPage() {
  const [state, setState] = useState<AuthStateResponse | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .getAuthState()
      .then(setState)
      .catch(() => setState(null));
  }, []);

  const changePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      toast.success("Password changed — every other browser has been signed out.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "could not change the password");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      // Signing out locally is the point; a failed call still sends us to login.
    }
    window.location.assign("/login");
  };

  return (
    <>
      <SettingsSection
        title="Operator"
        subtitle="The single identity this Panel and its Cores belong to."
        headingLevel="h1"
      >
        <Field label="Name">
          <div style={{ fontSize: 13, color: "var(--text-primary)" }}>
            {state?.operator?.name ?? "—"}
          </div>
        </Field>
      </SettingsSection>

      <SettingsSection title="Password">
        <form onSubmit={changePassword} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <TextField
            label="Current password"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={setCurrentPassword}
          />
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
            required
            value={newPassword}
            onChange={setNewPassword}
          />
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Changing the password signs out every browser, including the other devices
            you're signed in from.
          </div>
          <div>
            <Btn type="submit" variant="primary" disabled={busy}>
              {busy ? "Changing…" : "Change password"}
            </Btn>
          </div>
        </form>
      </SettingsSection>

      <SettingsSection title="Session">
        <Btn variant="danger" icon="shield" onClick={() => void signOut()}>
          Sign out
        </Btn>
      </SettingsSection>
    </>
  );
}

import { useEffect, useState } from "react";
import {
  addAllowed,
  listAllowed,
  removeAllowed,
  type AllowedEmail,
} from "../lib/api";

export function AdminSheet({
  currentEmail,
  onClose,
}: {
  currentEmail: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<AllowedEmail[] | null>(null);
  const [email, setEmail] = useState("");
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      setRows(await listAllowed());
    } catch (err: any) {
      setError(err?.message || "Could not load the invite list.");
    }
  }
  useEffect(() => {
    reload();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addAllowed(email.trim().toLowerCase(), makeAdmin);
      setEmail("");
      setMakeAdmin(false);
      await reload();
    } catch (err: any) {
      setError(err?.message || "Could not add that email.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: string) {
    if (!confirm(`Remove access for ${target}?`)) return;
    try {
      await removeAllowed(target);
      await reload();
    } catch (err: any) {
      setError(err?.message || "Could not remove that email.");
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>Manage access</h3>
        <p className="note" style={{ marginBottom: 14 }}>
          Anyone on this list can sign in with a magic link. Admins can manage
          the list too.
        </p>

        <form onSubmit={add}>
          <div className="field">
            <label>Invite an email</label>
            <input
              type="email"
              value={email}
              placeholder="friend@example.com"
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <label
            className="note"
            style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}
          >
            <input
              type="checkbox"
              checked={makeAdmin}
              onChange={(e) => setMakeAdmin(e.target.checked)}
            />
            Make them an admin (can manage access)
          </label>
          <button className="btn primary block" disabled={busy} type="submit">
            {busy ? "Adding…" : "＋ Add to invite list"}
          </button>
        </form>

        {error && (
          <div className="note" style={{ color: "var(--danger)", marginTop: 12 }}>
            {error}
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          {rows === null ? (
            <div className="note">Loading…</div>
          ) : (
            rows.map((r) => (
              <div
                key={r.email}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 0",
                  borderTop: "1px solid var(--line)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.email}
                    {r.email === currentEmail ? " (you)" : ""}
                  </div>
                  <div className="tag" style={{ fontSize: 11 }}>
                    {r.isAdmin ? "Admin" : "Member"}
                  </div>
                </div>
                {r.email !== currentEmail && (
                  <button className="btn danger" onClick={() => remove(r.email)}>
                    Remove
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        <button className="btn ghost block" style={{ marginTop: 16 }} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

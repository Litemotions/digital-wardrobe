import { useState } from "react";
import { requestLink } from "../lib/api";

export function Auth({ notice }: { notice?: string | null }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(notice ?? null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestLink(email.trim());
      setSent(true);
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">👗</span>
        <div>
          <h1>Digital Wardrobe</h1>
          <div className="sub">Invite-only · sign in with a magic link</div>
        </div>
      </header>

      <div className="sheet" style={{ position: "static", borderRadius: 20 }}>
        {sent ? (
          <>
            <h3>Check your email 📬</h3>
            <p className="note">
              If <strong>{email}</strong> is on the invite list, a sign-in link
              is on its way. It expires in 15 minutes. You can close this tab and
              open the link on any device.
            </p>
            <button
              className="btn ghost block"
              style={{ marginTop: 12 }}
              onClick={() => {
                setSent(false);
                setError(null);
              }}
            >
              Use a different email
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <h3>Sign in</h3>
            <div className="field">
              <label>Email</label>
              <input
                type="email"
                value={email}
                autoComplete="email"
                placeholder="you@example.com"
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            {error && (
              <div
                className="note"
                style={{ color: "var(--danger)", marginBottom: 12 }}
              >
                {error}
              </div>
            )}
            <button className="btn primary block" disabled={busy} type="submit">
              {busy ? (
                <>
                  <span className="spinner" /> Sending…
                </>
              ) : (
                "Send me a sign-in link"
              )}
            </button>
            <p className="note" style={{ textAlign: "center", marginTop: 14 }}>
              Access is invite-only. Ask the owner to add your email if you don't
              have access yet.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

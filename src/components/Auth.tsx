import { useState } from "react";
import { login, register, type User } from "../lib/api";

export function Auth({ onAuthed }: { onAuthed: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user =
        mode === "login"
          ? await login(email.trim(), password)
          : await register(email.trim(), password);
      onAuthed(user);
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
          <div className="sub">Sign in to sync your wardrobe</div>
        </div>
      </header>

      <form className="sheet" style={{ position: "static", borderRadius: 20 }} onSubmit={submit}>
        <h3>{mode === "login" ? "Welcome back" : "Create your account"}</h3>

        <div className="field">
          <label>Email</label>
          <input
            type="email"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>Password{mode === "register" ? " (min 8 characters)" : ""}</label>
          <input
            type="password"
            value={password}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        {error && (
          <div className="note" style={{ color: "var(--danger)", marginBottom: 12 }}>
            {error}
          </div>
        )}

        <button className="btn primary block" disabled={busy} type="submit">
          {busy ? (
            <>
              <span className="spinner" /> Please wait…
            </>
          ) : mode === "login" ? (
            "Sign in"
          ) : (
            "Create account"
          )}
        </button>

        <div className="note" style={{ textAlign: "center", marginTop: 14 }}>
          {mode === "login" ? "New here? " : "Already have an account? "}
          <button
            type="button"
            className="btn ghost"
            style={{ padding: "2px 6px" }}
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "Create an account" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}

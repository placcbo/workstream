import { useState } from "react";
import { useAuth } from "../context/AuthContext";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.56 2.7-3.87 2.7-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z" />
    </svg>
  );
}

export default function LoginPage() {
  const { login, register, isAuthenticating } = useAuth();
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user", inviteCode: "" });
  const [message, setMessage] = useState({ kind: "", text: "" });

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setMessage({ kind: "", text: "" });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setMessage({ kind: "", text: "" });

    if (mode === "register" && form.password.trim().length < 8) {
      setMessage({ kind: "error", text: "Password must be at least 8 characters long." });
      return;
    }

    try {
      if (mode === "register") {
        const result = await register(form);
        setMessage({
          kind: "success",
          text: result?.user ? "Account created. You can now log in." : "Account created.",
        });
        setMode("login");
        setForm((prev) => ({ ...prev, name: "", password: "", inviteCode: "" }));
      } else {
        const user = await login({ email: form.email, password: form.password });
        if (user) {
          setMessage({ kind: "success", text: `Welcome back, ${user.name || user.email}.` });
        }
      }
    } catch (err) {
      setMessage({ kind: "error", text: err?.message || "Something went wrong. Please try again." });
    }
  };

  return (
    <div className="login-page login-page--split">
      <div className="login-brand-panel">
        <div className="login-mark">
          <svg width="40" height="40" viewBox="0 0 34 34" fill="none">
            <rect x="2" y="2" width="30" height="30" rx="6" stroke="var(--amber)" strokeWidth="2.5" />
            <path d="M9 17h16M17 9v16" stroke="var(--amber)" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </div>
        <h1>WorkBoard</h1>
        <p className="login-sub">Reserve your hours on the shared shift ledger.</p>
      </div>

      <div className="login-form-panel">
        <div className="login-card">
          <h2 className="login-card-heading">{mode === "register" ? "Create account" : "Log in"}</h2>

          <button type="button" className="oauth-button" disabled title="Google sign-in is coming soon">
            <GoogleIcon />
            Continue with Google
            <span className="oauth-soon-badge">Soon</span>
          </button>

          <div className="login-divider">
            <span>OR</span>
          </div>

          <form className="auth-form" onSubmit={handleSubmit}>
            {mode === "register" && (
              <>
                <label className="auth-field">
                  <span className="auth-label">Name</span>
                  <input className="auth-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Your name" required />
                </label>
                <label className="auth-field">
                  <span className="auth-label">Account type</span>
                  <select className="auth-input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                    <option value="user">Agent</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
              </>
            )}

            <label className="auth-field">
              <span className="auth-label">Email</span>
              <input className="auth-input" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" required />
            </label>

            <label className="auth-field">
              <span className="auth-label">Password</span>
              <input
                className="auth-input"
                type="password"
                name="password"
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                minLength={8}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={mode === "register" ? "Choose a password" : "Enter password"}
                required
              />
              {mode === "register" && <span className="auth-hint">Use at least 8 characters.</span>}
            </label>

            {mode === "register" && form.role === "admin" && (
              <label className="auth-field">
                <span className="auth-label">Admin invite code</span>
                <input className="auth-input" value={form.inviteCode} onChange={(e) => setForm({ ...form, inviteCode: e.target.value })} placeholder="Enter invite code" required />
                <span className="auth-hint">Required only for admin sign-up.</span>
              </label>
            )}

            <button className="btn btn--amber auth-submit" disabled={isAuthenticating} type="submit">
              {mode === "register" ? "Create account" : "Log in"}
            </button>
          </form>

          {message.text && (
            <p className={`auth-message ${message.kind === "error" ? "auth-message--error" : "auth-message--success"}`} role={message.kind === "error" ? "alert" : "status"} aria-live="polite">
              {message.text}
            </p>
          )}

          <p className="login-toggle">
            {mode === "register" ? (
              <>
                Already have an account?{" "}
                <button type="button" className="login-toggle-link" onClick={() => switchMode("login")}>
                  Log in
                </button>
              </>
            ) : (
              <>
                Don't have an account?{" "}
                <button type="button" className="login-toggle-link" onClick={() => switchMode("register")}>
                  Sign up
                </button>
              </>
            )}
          </p>

          <p className="login-footnote">
            Accounts are stored in the running backend session store and reset when the server restarts.
          </p>
        </div>
      </div>
    </div>
  );
}

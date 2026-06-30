import { useState } from "react";
import { useAuth } from "../context/AuthContext";

export default function LoginPage() {
  const { login, register, isAuthenticating } = useAuth();
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user", inviteCode: "" });
  const [message, setMessage] = useState({ kind: "", text: "" });

  const handleSubmit = async (event) => {
    event.preventDefault();
    setMessage({ kind: "", text: "" });
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
    <div className="login-page">
      <div className="login-card">
        <div className="login-mark">
          <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
            <rect x="2" y="2" width="30" height="30" rx="6" stroke="var(--amber)" strokeWidth="2.5" />
            <path d="M9 17h16M17 9v16" stroke="var(--amber)" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </div>
        <h1>WorkBoard</h1>
        <p className="login-sub">Reserve your hours on the shared shift ledger.</p>

        <div className="login-mode-switch" role="tablist" aria-label="Authentication mode">
          <button type="button" className={`login-mode-button ${mode === "login" ? "login-mode-button--active" : ""}`} onClick={() => setMode("login")}>
            Log in
          </button>
          <button type="button" className={`login-mode-button ${mode === "register" ? "login-mode-button--active" : ""}`} onClick={() => setMode("register")}>
            Register
          </button>
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
            <input className="auth-input" type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Enter password" required />
          </label>

          {mode === "register" && form.role === "admin" && (
            <label className="auth-field">
              <span className="auth-label">Admin invite code</span>
              <input className="auth-input" value={form.inviteCode} onChange={(e) => setForm({ ...form, inviteCode: e.target.value })} placeholder="Enter invite code" required />
              <span className="auth-hint">Required only for admin sign-up.</span>
            </label>
          )}

          <button className="btn btn--teal auth-submit" disabled={isAuthenticating} type="submit">
            {mode === "register" ? "Create account" : "Log in"}
          </button>
        </form>

        {message.text && (
          <p className={`auth-message ${message.kind === "error" ? "auth-message--error" : "auth-message--success"}`} role={message.kind === "error" ? "alert" : "status"} aria-live="polite">
            {message.text}
          </p>
        )}

        <p className="login-footnote">
          Accounts are stored in the running backend session store and reset when the server restarts.
        </p>
      </div>
    </div>
  );
}

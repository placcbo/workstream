import { useAuth, MOCK_ACCOUNTS } from "../context/AuthContext";

export default function LoginPage() {
  const { login, isAuthenticating } = useAuth();

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

        <div className="login-divider">
          <span>continue with</span>
        </div>

        <div className="account-list">
          {MOCK_ACCOUNTS.map((account) => (
            <button
              key={account.id}
              className="account-row"
              disabled={isAuthenticating}
              onClick={() => login(account.id)}
            >
              <img src={account.avatarUrl} alt="" className="account-avatar" />
              <span className="account-meta">
                <span className="account-name">{account.name}</span>
                <span className="account-email">{account.email}</span>
              </span>
              <svg className="google-g" width="18" height="18" viewBox="0 0 18 18">
                <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.9A8.9 8.9 0 0 0 17.64 9.2z" />
                <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.85.86-3.06.86-2.36 0-4.36-1.59-5.08-3.74H.92v2.33A9 9 0 0 0 9 18z" />
                <path fill="#FBBC05" d="M3.92 10.68A5.4 5.4 0 0 1 3.64 9c0-.58.1-1.15.28-1.68V4.99H.92A9 9 0 0 0 0 9c0 1.45.35 2.83.92 4.01l3-2.33z" />
                <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .92 4.99l3 2.33C4.64 5.17 6.64 3.58 9 3.58z" />
              </svg>
            </button>
          ))}
        </div>

        <p className="login-footnote">
          Mocked for now — this picker will become the real Google sign-in button once the Go backend is wired up.
        </p>
      </div>
    </div>
  );
}

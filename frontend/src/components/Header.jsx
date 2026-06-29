export default function Header({ user, onLogout, onShowReservedBlocks, timerRunning }) {
  // Bug fix: admin-2 (and any future account) may have no avatarUrl.
  // Render a text-initial avatar as a safe fallback instead of a broken <img>.
  const initials = user.name
    ? user.name
        .split(" ")
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase()
    : "?";

  return (
    <header className="app-header">
      <div className="app-brand">
        <svg width="26" height="26" viewBox="0 0 34 34" fill="none">
          <rect x="2" y="2" width="30" height="30" rx="6" stroke="var(--amber)" strokeWidth="2.5" />
          <path d="M9 17h16M17 9v16" stroke="var(--amber)" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <button
          className={`btn btn--ghost app-brand-button ${timerRunning ? "app-brand-button--active" : ""}`}
          onClick={onShowReservedBlocks}
          title={timerRunning ? "Timer running" : "Open reserved blocks panel"}
        >
          ⏱
        </button>
        <span>WorkBoard</span>
        {user.role === "admin" && <span className="role-badge">ADMIN</span>}
      </div>
      <div className="app-identity">
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="app-avatar" />
        ) : (
          <span className="app-avatar app-avatar--initials" aria-hidden="true">
            {initials}
          </span>
        )}
        <div className="app-identity-text">
          <span className="app-identity-name">{user.name}</span>
          <span className="app-identity-email">{user.email}</span>
        </div>
        <button className="btn btn--ghost" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </header>
  );
}
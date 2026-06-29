import { useState, useEffect } from "react";

export default function AdminProjectsAndUsers({
  adminId,
  projects = [],
  onAddProject,
  userAccess = {},
  onGrantAccess,
  onRevokeAccess,
}) {
  const [newProjectName, setNewProjectName] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [selectedProjectForAccess, setSelectedProjectForAccess] = useState(projects[0] || "");

  useEffect(() => {
    if (projects.length > 0 && !projects.includes(selectedProjectForAccess)) {
      setSelectedProjectForAccess(projects[0]);
    }
  }, [projects, selectedProjectForAccess]);

  const handleAddProject = () => {
    const name = newProjectName.trim();
    if (!name) return;
    onAddProject?.(name);
    setNewProjectName("");
  };

  const handleGrantAccess = () => {
    const email = emailInput.trim();
    if (!email || !selectedProjectForAccess) return;
    onGrantAccess?.(email, selectedProjectForAccess);
    setEmailInput("");
  };

  return (
    <div className="admin-projects-users">
      <div className="apu-section">
        <div className="apu-section-head">
          <h2 className="apu-title">My Projects</h2>
          <p className="apu-subtitle">Projects managed by {adminId}</p>
        </div>

        {projects.length === 0 ? (
          <div className="apu-empty">No projects yet. Create one to get started.</div>
        ) : (
          <div className="apu-project-list">
            {projects.map((project) => (
              <div key={project} className="apu-project-item">
                <span className="apu-project-name">{project}</span>
              </div>
            ))}
          </div>
        )}

        <div className="apu-form">
          <input
            className="apu-input"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            placeholder="New project name…"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddProject();
            }}
          />
          <button
            className="btn btn--ghost"
            onClick={handleAddProject}
            disabled={!newProjectName.trim()}
          >
            Add Project
          </button>
        </div>
      </div>

      <div className="apu-section">
        <div className="apu-section-head">
          <h2 className="apu-title">User Access</h2>
          <p className="apu-subtitle">Grant users access to your projects</p>
        </div>

        {projects.length === 0 ? (
          <div className="apu-empty">Create a project first to grant access.</div>
        ) : (
          <>
            <div className="apu-form">
              <select
                className="apu-input"
                value={selectedProjectForAccess}
                onChange={(e) => setSelectedProjectForAccess(e.target.value)}
              >
                <option value="">Select a project…</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <input
                className="apu-input"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="user@example.com"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleGrantAccess();
                }}
              />
              <button
                className="btn btn--ghost"
                onClick={handleGrantAccess}
                disabled={!emailInput.trim() || !selectedProjectForAccess}
              >
                Grant
              </button>
            </div>

            {projects.map((project) => {
              const emails = userAccess[project] || [];
              if (emails.length === 0) return null;
              return (
                <div key={project} className="apu-access-group">
                  <span className="apu-access-label">{project}</span>
                  <div className="apu-pill-row">
                    {emails.map((email) => (
                      <span key={email} className="apu-pill">
                        {email}
                        <button
                          type="button"
                          className="apu-pill-remove"
                          onClick={() => onRevokeAccess?.(email, project)}
                          title="Remove access"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

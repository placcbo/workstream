import { MAX_HOURS_PER_DAY } from "../data/schedule";

export default function TimeInsights({
  reportedHours,
  reservedHours,
  releasedHours,
  rangeLabel,
  daysInRange,
  projectCount = 1,
  isAdmin,
  todayByProject = [],
}) {
  const capacity = Math.max(isAdmin ? releasedHours : MAX_HOURS_PER_DAY * daysInRange * projectCount, 1);
  const reportedPct = Math.min(100, (reportedHours / capacity) * 100);
  const upcomingHours = Math.max(0, reservedHours - reportedHours);
  const upcomingPct = Math.min(100 - reportedPct, (upcomingHours / capacity) * 100);

  return (
    <div className="time-insights">
      <div className="time-insights-title">Time insights</div>
      <div className="time-insights-range">{rangeLabel}</div>

      <div className="time-insights-bar-track">
        <div className="time-insights-bar-fill time-insights-bar-fill--reported" style={{ width: `${reportedPct}%` }} />
        <div
          className="time-insights-bar-fill time-insights-bar-fill--upcoming"
          style={{ width: `${upcomingPct}%`, left: `${reportedPct}%` }}
        />
      </div>

      <div className="time-insights-legend">
        <div className="time-insights-stat">
          <span className="time-insights-swatch time-insights-swatch--reported" />
          <span className="time-insights-stat-label">Reported hours</span>
          <span className="time-insights-stat-value">{reportedHours}h</span>
        </div>
        <div className="time-insights-stat">
          <span className="time-insights-swatch time-insights-swatch--upcoming" />
          <span className="time-insights-stat-label">{isAdmin ? "Total reserved" : "Reserved hours"}</span>
          <span className="time-insights-stat-value">{reservedHours}h</span>
        </div>
        {isAdmin && (
          <div className="time-insights-stat">
            <span className="time-insights-swatch time-insights-swatch--released" />
            <span className="time-insights-stat-label">Total released</span>
            <span className="time-insights-stat-value">{releasedHours}h</span>
          </div>
        )}
      </div>

      {!isAdmin && todayByProject.length > 1 && (
        <div className="time-insights-projects">
          <span className="time-insights-projects-label">Today, by project</span>
          {todayByProject.map(({ workType, hours }) => (
            <div key={workType} className="time-insights-project-row">
              <span className="time-insights-project-name">{workType}</span>
              <span className="time-insights-project-hours">
                {hours}/{MAX_HOURS_PER_DAY}h
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

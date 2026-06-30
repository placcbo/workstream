import { useEffect, useMemo, useState } from "react";

const STANDARD_SHIFT_TIMES = { startTime: "08:00", endTime: "17:00" };

const WEEKDAYS = [
  { value: 0, label: "Su" },
  { value: 1, label: "Mo" },
  { value: 2, label: "Tu" },
  { value: 3, label: "We" },
  { value: 4, label: "Th" },
  { value: 5, label: "Fr" },
  { value: 6, label: "Sa" },
];

const WEEKDAY_PRESETS = [
  { label: "Mon–Fri", days: [1, 2, 3, 4, 5] },
  { label: "Mon–Sat", days: [1, 2, 3, 4, 5, 6] },
  { label: "Every day", days: [0, 1, 2, 3, 4, 5, 6] },
  { label: "Weekends", days: [0, 6] },
];

function sameDaySet(a, b) {
  if (a.size !== b.size) return false;
  for (const day of a) if (!b.has(day)) return false;
  return true;
}

/** Mirrors the backend's recurringDateKeys — used only for a live preview. */
function previewRecurringDateKeys(startDateKey, endDateKey, frequency, weekdaySet) {
  if (!startDateKey || !endDateKey || endDateKey < startDateKey) return [];
  const start = new Date(`${startDateKey}T00:00:00`);
  const end = new Date(`${endDateKey}T00:00:00`);
  const keys = [];
  const toKey = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  if (frequency === "monthly") {
    const cursor = new Date(start);
    while (cursor <= end) {
      keys.push(toKey(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
      if (keys.length > 400) break;
    }
    return keys;
  }
  const includeAll = weekdaySet.size === 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    if (includeAll || weekdaySet.has(cursor.getDay())) keys.push(toKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
    if (keys.length > 400) break;
  }
  return keys;
}

function getDefaultTimesForDate(dateKey) {
  // All days use the same default shift window — Saturday/Sunday are not
  // treated specially.
  return STANDARD_SHIFT_TIMES;
}

function fillClass(pct) {
  if (pct >= 100) return "arp-fill--full";
  if (pct >= 50)  return "arp-fill--partial";
  return "arp-fill--empty";
}

export default function AdminReleasePanel({
  onRelease,
  onSelectBlock,
  onProjectFilterChange,
  disabled,
  selectedDate,
  onDateChange,
  customWorkTypes = [],
  onAddWorkType,
  dateBlocks = [],
  highlightedProject = null,
}) {
  const allWorkTypes = customWorkTypes;

  const [totalHours, setTotalHours]           = useState(50);
  const [maxHoursPerUser, setMaxHoursPerUser] = useState(8);
  const [workType, setWorkType]               = useState(allWorkTypes[0] ?? "");
  const [startTime, setStartTime] = useState(() => getDefaultTimesForDate(selectedDate).startTime);
  const [endTime,   setEndTime]   = useState(() => getDefaultTimesForDate(selectedDate).endTime);

  // ── Recurrence ──────────────────────────────────────────────────────────
  const [isRecurring, setIsRecurring]   = useState(false);
  const [frequency, setFrequency]       = useState("weekly"); // "daily" | "weekly" | "monthly"
  const [recurrenceEnd, setRecurrenceEnd] = useState(selectedDate);
  const [weekdays, setWeekdays]         = useState(() => new Set([1, 2, 3, 4, 5])); // Mon–Fri default

  const toggleWeekday = (day) => {
    setWeekdays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  };

  const applyPreset = (days) => setWeekdays(new Set(days));
  const activePreset = WEEKDAY_PRESETS.find((preset) => sameDaySet(new Set(preset.days), weekdays));

  useEffect(() => {
    if (allWorkTypes.length === 0) {
      setWorkType("");
    } else {
      // Auto-select first project when they become available
      if (!workType || !allWorkTypes.includes(workType)) {
        setWorkType(allWorkTypes[0]);
      }
    }
  }, [allWorkTypes.join(",")]);

  // When a new project is highlighted (just created), auto-select it
  useEffect(() => {
    if (highlightedProject && customWorkTypes.includes(highlightedProject)) {
      setWorkType(highlightedProject);
    }
  }, [highlightedProject, customWorkTypes.join(",")]);

  useEffect(() => {
    const defaults = getDefaultTimesForDate(selectedDate);
    setStartTime(defaults.startTime);
    setEndTime(defaults.endTime);
  }, [selectedDate]);

  const effectiveWorkType   = workType;
  const projectBlocks       = dateBlocks.filter((b) => b.workType === effectiveWorkType);
  const projectReleased     = projectBlocks.reduce((s, b) => s + b.totalHours, 0);
  const projectClaimed      = projectBlocks.reduce((s, b) => s + (b.reservedHours ?? 0), 0);
  const projectRemaining    = Math.max(0, projectReleased - projectClaimed);
  const projectClaimedPct   = projectReleased > 0
    ? Math.min(100, Math.round((projectClaimed / projectReleased) * 100))
    : 0;

  useEffect(() => {
    if (!onProjectFilterChange || !workType) return;
    onProjectFilterChange(workType || null);
  }, [workType, onProjectFilterChange]);

  useEffect(() => {
    // Keep the recurrence end date from drifting before the start date when
    // the admin changes the picked date after already setting one up.
    setRecurrenceEnd((prev) => (prev < selectedDate ? selectedDate : prev));
  }, [selectedDate]);

  const recurrenceValid =
    !isRecurring ||
    (recurrenceEnd >= selectedDate && (frequency === "monthly" || weekdays.size > 0));

  const recurringPreviewDates = useMemo(
    () => (isRecurring && recurrenceValid ? previewRecurringDateKeys(selectedDate, recurrenceEnd, frequency, weekdays) : []),
    [isRecurring, recurrenceValid, selectedDate, recurrenceEnd, frequency, weekdays]
  );
  const recurringOccurrences = recurringPreviewDates.length;
  const recurringPoolTooSmall = isRecurring && recurringOccurrences > 0 && totalHours < recurringOccurrences;
  const recurringHoursPerDate = recurringOccurrences > 0 ? Math.floor(totalHours / recurringOccurrences) : 0;
  const recurringHoursRemainder = recurringOccurrences > 0 ? totalHours % recurringOccurrences : 0;

  const canRelease =
    !disabled && totalHours >= 1 && effectiveWorkType.length > 0 && recurrenceValid && !recurringPoolTooSmall;

  return (
    <div className="arp">
      {/* ── Section 1: Release form ── */}
      <div className="arp-section">
        <div className="arp-section-head">
          <span className="arp-section-eyebrow">Admin</span>
          <h2 className="arp-section-title">Release capacity</h2>
          <p className="arp-section-sub">Pick a project and define the shift window made available to workers.</p>
        </div>

        {/* Project selector */}
        {allWorkTypes.length === 0 ? (
          <div className="arp-empty" style={{ marginBottom: "14px" }}>
            Create a project in "My Projects" first to release capacity.
          </div>
        ) : (
          <div className="arp-project-row">
            <select
              className="arp-input arp-select"
              value={workType || ""}
              onChange={(e) => {
                if (e.target.value) {
                  setWorkType(e.target.value);
                }
              }}
            >
              {!workType && <option value="">Select a project…</option>}
              {allWorkTypes.map((wt) => (
                <option key={wt} value={wt}>{wt}</option>
              ))}
            </select>
          </div>
        )}

        {/* Form grid */}
        <div className="arp-form-grid">
          <label className="arp-field">
            <span className="arp-field-label">{isRecurring ? "Start date" : "Date"}</span>
            <input
              className="arp-input"
              type="date"
              value={selectedDate}
              onChange={(e) => onDateChange(e.target.value)}
            />
          </label>
          <label className="arp-field">
            <span className="arp-field-label">Start</span>
            <input className="arp-input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </label>
          <label className="arp-field">
            <span className="arp-field-label">End</span>
            <input className="arp-input" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </label>
          <label className="arp-field">
            <span className="arp-field-label">{isRecurring ? "Total hours (pool)" : "Total hours"}</span>
            <input
              className="arp-input"
              type="number" min="1" max={isRecurring ? 10000 : 200}
              value={totalHours}
              onChange={(e) => setTotalHours(Number(e.target.value))}
            />
          </label>
          <label className="arp-field">
            <span className="arp-field-label">Max / user</span>
            <input
              className="arp-input"
              type="number" min="1" max="24"
              value={maxHoursPerUser}
              onChange={(e) => setMaxHoursPerUser(Number(e.target.value))}
            />
          </label>
        </div>

        {/* Recurrence */}
        <div className="arp-recurrence">
          <label className="arp-recurrence-toggle">
            <input
              type="checkbox"
              checked={isRecurring}
              onChange={(e) => setIsRecurring(e.target.checked)}
            />
            <span>Repeat this release</span>
          </label>

          {isRecurring && (
            <div className="arp-recurrence-body">
              <div className="arp-recurrence-row">
                <label className="arp-field">
                  <span className="arp-field-label">Frequency</span>
                  <select
                    className="arp-input arp-select"
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value)}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </label>
                <label className="arp-field">
                  <span className="arp-field-label">Until</span>
                  <input
                    className="arp-input"
                    type="date"
                    min={selectedDate}
                    value={recurrenceEnd}
                    onChange={(e) => setRecurrenceEnd(e.target.value)}
                  />
                </label>
              </div>

              {frequency === "monthly" ? (
                <p className="arp-recurrence-hint">
                  Repeats every month on the same date as the start date above, through the end date.
                </p>
              ) : (
                <>
                  <div className="arp-recurrence-presets">
                    {WEEKDAY_PRESETS.map((preset) => (
                      <button
                        type="button"
                        key={preset.label}
                        className={`arp-preset-chip ${activePreset?.label === preset.label ? "arp-preset-chip--active" : ""}`}
                        onClick={() => applyPreset(preset.days)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <div className="arp-recurrence-weekdays">
                    {WEEKDAYS.map((day) => (
                      <button
                        type="button"
                        key={day.value}
                        className={`arp-weekday-chip ${weekdays.has(day.value) ? "arp-weekday-chip--active" : ""}`}
                        onClick={() => toggleWeekday(day.value)}
                        aria-pressed={weekdays.has(day.value)}
                      >
                        {day.label}
                      </button>
                    ))}
                  </div>
                  {weekdays.size === 0 && (
                    <p className="arp-recurrence-hint arp-recurrence-hint--warn">Pick at least one day of the week.</p>
                  )}
                </>
              )}

              {recurringOccurrences > 0 && (
                recurringPoolTooSmall ? (
                  <p className="arp-recurrence-hint arp-recurrence-hint--warn">
                    {totalHours}h isn't enough to cover {recurringOccurrences} releases (1h minimum each) — raise the
                    total hours or shorten the date range.
                  </p>
                ) : (
                  <p className="arp-recurrence-hint">
                    {totalHours}h split across <strong>{recurringOccurrences}</strong> day{recurringOccurrences === 1 ? "" : "s"} ≈{" "}
                    {recurringHoursRemainder === 0
                      ? `${recurringHoursPerDate}h each.`
                      : `${recurringHoursPerDate}–${recurringHoursPerDate + 1}h each.`}
                  </p>
                )
              )}
            </div>
          )}
        </div>

        <div className="arp-release-row">
          <button
            className="btn btn--amber arp-release-btn"
            disabled={!canRelease}
            onClick={() => {
              onRelease({
                dateKey: selectedDate,
                totalHours,
                shiftName: effectiveWorkType,
                startTime,
                endTime,
                workType: effectiveWorkType,
                maxHoursPerUser,
                recurrence: isRecurring
                  ? {
                      frequency,
                      endDate: recurrenceEnd,
                      weekdays: Array.from(weekdays),
                    }
                  : null,
              });
            }}
          >
            {isRecurring
              ? `Release ${totalHours}h across ${recurringOccurrences || "…"} day${recurringOccurrences === 1 ? "" : "s"}`
              : `Release ${totalHours}h`}
          </button>
        </div>
      </div>

      {/* ── Section 2: Project status ── */}
      {effectiveWorkType && (
        <div className="arp-section arp-section--status">
          <div className="arp-section-head">
            <div className="arp-project-badge">
              <span className="arp-project-dot" />
              {effectiveWorkType}
            </div>
            <p className="arp-section-sub" style={{ marginTop: 4 }}>
              Capacity for the selected date
            </p>
          </div>

          {projectReleased === 0 ? (
            <div className="arp-empty">No blocks released for <strong>{effectiveWorkType}</strong> on this date yet.</div>
          ) : (
            <>
              {/* Stat strip */}
              <div className="arp-stat-strip">
                <div className="arp-stat">
                  <span className="arp-stat-value">{projectReleased}h</span>
                  <span className="arp-stat-label">Released</span>
                </div>
                <div className="arp-stat-divider" />
                <div className="arp-stat">
                  <span className="arp-stat-value arp-stat-value--claimed">{projectClaimed}h</span>
                  <span className="arp-stat-label">Claimed</span>
                </div>
                <div className="arp-stat-divider" />
                <div className="arp-stat">
                  <span className="arp-stat-value arp-stat-value--remaining">{projectRemaining}h</span>
                  <span className="arp-stat-label">Remaining</span>
                </div>
                <div className="arp-stat-divider" />
                <div className="arp-stat">
                  <span className="arp-stat-value">{projectClaimedPct}%</span>
                  <span className="arp-stat-label">Fill rate</span>
                </div>
              </div>

              {/* Fill bar */}
              <div className="arp-bar-track">
                <div
                  className={"arp-bar-fill " + fillClass(projectClaimedPct)}
                  style={{ width: `${projectClaimedPct}%` }}
                />
              </div>

              {/* Block list */}
              <div className="arp-block-list">
                {projectBlocks.map((block) => {
                  const pct = block.totalHours > 0
                    ? Math.round(((block.reservedHours ?? 0) / block.totalHours) * 100)
                    : 0;
                  return (
                    <div key={block.id} className="arp-block">
                      <div className="arp-block-bar" style={{ width: `${pct}%` }} />
                      <div className="arp-block-content">
                        <div className="arp-block-top">
                          <span className="arp-block-name">{block.shiftName || block.workType}</span>
                          <span className="arp-block-time">{block.startTime} – {block.endTime}</span>
                        </div>
                        <div className="arp-block-meta">
                          <span className="arp-block-chip">{block.totalHours}h released</span>
                          <span className="arp-block-chip arp-block-chip--claimed">{block.reservedHours ?? 0}h claimed</span>
                          <span className="arp-block-chip arp-block-chip--remaining">{block.remainingHours}h left</span>
                          <span className="arp-block-chip arp-block-chip--cap">cap {block.maxHoursPerUser ?? 8}h</span>
                        </div>
                      </div>
                      {onSelectBlock && (
                        <button
                          type="button"
                          className="arp-block-adjust"
                          onClick={() => onSelectBlock(selectedDate, block)}
                          title="Adjust block"
                        >
                          ✎
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

    </div>
  );
}
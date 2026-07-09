import { buildMonthGrid } from "../data/schedule";

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** Sum of `myHours` across a day's blocks — the current (non-admin) user's
 * own claimed hours that day, since the day summary from the backend is
 * block-level (everyone's claims combined), not per-user. */
function myHoursForDay(dayInfo) {
  return (dayInfo?.blocks ?? []).reduce((sum, block) => sum + (block.myHours || 0), 0);
}

export default function MonthGrid({ year, month, monthData, isAdmin, todayKey, onSelectDay, loading }) {
  const cells = buildMonthGrid(year, month);

  return (
    <div className="month-grid">
      <div className="month-grid-weekdays">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w} className="month-grid-weekday">
            {w}
          </span>
        ))}
      </div>
      <div className="month-grid-cells" aria-busy={loading || undefined}>
        {cells.map(({ dateKey, inMonth }) => {
          const dayNum = Number(dateKey.slice(-2));
          const isToday = dateKey === todayKey;
          const dayInfo = monthData[dateKey];
          const released = dayInfo?.summary?.releasedHours ?? 0;
          const remaining = dayInfo?.summary?.remainingHours ?? 0;
          const myHours = myHoursForDay(dayInfo);

          return (
            <button
              key={dateKey}
              type="button"
              className={["month-grid-cell", !inMonth && "month-grid-cell--muted", isToday && "month-grid-cell--today"]
                .filter(Boolean)
                .join(" ")}
              disabled={!inMonth}
              onClick={() => inMonth && onSelectDay(dateKey)}
            >
              <span className="month-grid-daynum">{dayNum}</span>
              {inMonth && !loading && (
                <span className="month-grid-day-stats">
                  {isAdmin
                    ? released > 0 && (
                        <>
                          <span className="month-grid-stat month-grid-stat--released">{released}h</span>
                          {remaining > 0 && <span className="month-grid-stat month-grid-stat--open">{remaining}h open</span>}
                        </>
                      )
                    : myHours > 0 && <span className="month-grid-stat month-grid-stat--mine">{myHours}h you</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { buildMonthGrid, formatMonthHeading, toDateKey } from "../data/schedule";

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export default function MiniMonth({ year, month, onPrevMonth, onNextMonth, selectedDate, onSelectDate, todayKey }) {
  const cells = buildMonthGrid(year, month);
  const selectedKey = toDateKey(selectedDate);

  return (
    <div className="mini-month">
      <div className="mini-month-header">
        <span className="mini-month-title">{formatMonthHeading(year, month)}</span>
        <div className="mini-month-nav">
          <button aria-label="Previous month" onClick={onPrevMonth}>
            ‹
          </button>
          <button aria-label="Next month" onClick={onNextMonth}>
            ›
          </button>
        </div>
      </div>
      <div className="mini-month-grid mini-month-grid--labels">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w} className="mini-month-weekday">
            {w}
          </span>
        ))}
      </div>
      <div className="mini-month-grid">
        {cells.map(({ dateKey, inMonth }) => {
          const dayNum = Number(dateKey.slice(-2));
          const isSelected = dateKey === selectedKey;
          const isToday = dateKey === todayKey;
          return (
            <button
              key={dateKey}
              className={[
                "mini-month-cell",
                !inMonth && "mini-month-cell--muted",
                isSelected && "mini-month-cell--selected",
                isToday && !isSelected && "mini-month-cell--today",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelectDate(new Date(`${dateKey}T00:00:00`))}
            >
              {dayNum}
            </button>
          );
        })}
      </div>
    </div>
  );
}

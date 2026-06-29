import { MAX_HOURS_PER_DAY } from "../data/schedule";

export default function HourGauge({ committedHours, pendingHours }) {
  const total = committedHours + pendingHours;
  const overBudget = total > MAX_HOURS_PER_DAY;
  const pct = (n) => Math.min(100, (n / MAX_HOURS_PER_DAY) * 100);

  return (
    <div className="hour-gauge" role="meter" aria-valuemin={0} aria-valuemax={MAX_HOURS_PER_DAY} aria-valuenow={total}>
      <div className="hour-gauge-track">
        <div
          className="hour-gauge-fill hour-gauge-fill--committed"
          style={{ height: `${pct(committedHours)}%` }}
        />
        <div
          className="hour-gauge-fill hour-gauge-fill--pending"
          style={{
            height: `${pct(total) - pct(committedHours)}%`,
            bottom: `${pct(committedHours)}%`,
          }}
        />
        {Array.from({ length: MAX_HOURS_PER_DAY - 1 }, (_, i) => (
          <div key={i} className="hour-gauge-tick" style={{ bottom: `${((i + 1) / MAX_HOURS_PER_DAY) * 100}%` }} />
        ))}
      </div>
      <div className="hour-gauge-readout">
        <span className={`hour-gauge-value ${overBudget ? "is-over" : ""}`}>{total}</span>
        <span className="hour-gauge-max">/{MAX_HOURS_PER_DAY}h</span>
      </div>
    </div>
  );
}

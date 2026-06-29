import { useMemo } from "react";
import { formatWeekdayShort } from "../data/schedule";

// ─── tiny helpers ────────────────────────────────────────────────────────────

function pct(value, total) {
  if (!total || total === 0) return 0;
  return Math.min(100, Math.round((value / total) * 100));
}

// Rotate through a palette keyed by project name so each project gets a
// consistent colour regardless of render order.
const PROJECT_COLORS = [
  { fill: "var(--amber)",  dim: "rgba(232,163,61,0.18)",  text: "#f5c97a" },
  { fill: "var(--teal)",   dim: "rgba(61,140,125,0.18)",  text: "#7ecfbf" },
  { fill: "var(--sky)",    dim: "rgba(121,199,221,0.18)", text: "#9dd8e8" },
  { fill: "var(--lime)",   dim: "rgba(139,210,74,0.18)",  text: "#b1e07a" },
  { fill: "var(--rust)",   dim: "rgba(193,80,46,0.18)",   text: "#e08870" },
  { fill: "var(--slate)",  dim: "rgba(107,122,143,0.18)", text: "#9aadc3" },
];

function colorFor(name, allNames) {
  const idx = allNames.indexOf(name);
  return PROJECT_COLORS[idx % PROJECT_COLORS.length] ?? PROJECT_COLORS[0];
}

// ─── sub-components ──────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }) {
  return (
    <div className="ai-stat-card" style={{ "--accent": accent }}>
      <span className="ai-stat-value">{value}</span>
      <span className="ai-stat-label">{label}</span>
      {sub && <span className="ai-stat-sub">{sub}</span>}
    </div>
  );
}

function FillBar({ fillPct, color, height = 8 }) {
  return (
    <div className="ai-fill-track" style={{ height }}>
      <div
        className="ai-fill-bar"
        style={{ width: `${fillPct}%`, background: color }}
      />
    </div>
  );
}

// Per-project breakdown row
function ProjectRow({ name, released, claimed, remaining, color, allNames }) {
  const clr = color ?? colorFor(name, allNames);
  const fillPct = pct(claimed, released);
  return (
    <div className="ai-project-row">
      <div className="ai-project-row-head">
        <span className="ai-project-dot" style={{ background: clr.fill }} />
        <span className="ai-project-name">{name}</span>
        <span className="ai-project-nums" style={{ color: clr.text }}>
          {claimed}h / {released}h
        </span>
        <span className="ai-project-pct">{fillPct}%</span>
      </div>
      <FillBar fillPct={fillPct} color={clr.fill} />
    </div>
  );
}

// Per-day mini bar chart
function DayBars({ dateKeys, weekData, projectFilter }) {
  const max = useMemo(() => {
    let m = 1;
    dateKeys.forEach((dk) => {
      const blocks = weekData[dk]?.blocks ?? [];
      const filtered = projectFilter
        ? blocks.filter((b) => b.workType === projectFilter)
        : blocks;
      const rel = filtered.reduce((s, b) => s + b.totalHours, 0);
      if (rel > m) m = rel;
    });
    return m;
  }, [dateKeys, weekData, projectFilter]);

  return (
    <div className="ai-day-bars">
      {dateKeys.map((dk) => {
        const blocks = weekData[dk]?.blocks ?? [];
        const filtered = projectFilter
          ? blocks.filter((b) => b.workType === projectFilter)
          : blocks;
        const rel = filtered.reduce((s, b) => s + b.totalHours, 0);
        const cls = filtered.reduce((s, b) => s + (b.reservedHours ?? 0), 0);
        const relPct = pct(rel, max);
        const clsPct = pct(cls, max);
        return (
          <div key={dk} className="ai-day-bar-col">
            <div className="ai-day-bar-wrap">
              <div className="ai-day-bar-track">
                <div className="ai-day-bar-released" style={{ height: `${relPct}%` }} />
                <div className="ai-day-bar-claimed"  style={{ height: `${clsPct}%` }} />
              </div>
            </div>
            <span className="ai-day-bar-label">{formatWeekdayShort(dk)}</span>
            {rel > 0 && (
              <span className="ai-day-bar-num">{rel}h</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Donut / ring chart (SVG)
function RingChart({ fillPct, color, size = 64, stroke = 10, label }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (fillPct / 100) * circ;
  return (
    <div className="ai-ring-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block" }}>
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none"
          stroke="rgba(244,239,228,0.08)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ / 4}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.4s ease" }}
        />
      </svg>
      <span className="ai-ring-pct" style={{ color }}>{fillPct}%</span>
      {label && <span className="ai-ring-label">{label}</span>}
    </div>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

/**
 * AdminInsights
 *
 * Props:
 *   dateKeys       string[]        — the 7 date keys currently in view
 *   weekData       { [dk]: { blocks, summary } }
 *   customWorkTypes string[]       — projects this admin has created
 *   projectFilter  string | null   — currently selected project in release panel
 */
export default function AdminInsights({ dateKeys, weekData, customWorkTypes = [], projectFilter }) {
  // ── aggregate across the whole visible week ──────────────────────────────
  const agg = useMemo(() => {
    let totalReleased = 0;
    let totalClaimed  = 0;
    const byProject   = {};  // { [workType]: { released, claimed } }
    const byDay       = {};  // { [dateKey]:  { released, claimed } }

    dateKeys.forEach((dk) => {
      const blocks = weekData[dk]?.blocks ?? [];
      let dayRel = 0, dayCls = 0;

      blocks.forEach((b) => {
        const rel = b.totalHours ?? 0;
        const cls = b.reservedHours ?? 0;
        totalReleased += rel;
        totalClaimed  += cls;
        dayRel        += rel;
        dayCls        += cls;

        const wt = b.workType ?? "Unknown";
        if (!byProject[wt]) byProject[wt] = { released: 0, claimed: 0 };
        byProject[wt].released += rel;
        byProject[wt].claimed  += cls;
      });

      byDay[dk] = { released: dayRel, claimed: dayCls };
    });

    const totalRemaining = Math.max(0, totalReleased - totalClaimed);
    const fillRate       = pct(totalClaimed, totalReleased);
    const activeDays     = Object.values(byDay).filter((d) => d.released > 0).length;

    return { totalReleased, totalClaimed, totalRemaining, fillRate, byProject, byDay, activeDays };
  }, [dateKeys, weekData]);

  // project names in a stable order (custom first, then anything else)
  const allProjectNames = useMemo(() => {
    const fromBlocks = Object.keys(agg.byProject);
    const ordered    = [...new Set([...customWorkTypes, ...fromBlocks])];
    return ordered.filter((n) => agg.byProject[n]);
  }, [agg.byProject, customWorkTypes]);

  // ── busiest day ──────────────────────────────────────────────────────────
  const busiestDay = useMemo(() => {
    let best = null, bestCls = 0;
    Object.entries(agg.byDay).forEach(([dk, { claimed }]) => {
      if (claimed > bestCls) { best = dk; bestCls = claimed; }
    });
    return best ? { dk: best, hours: bestCls } : null;
  }, [agg.byDay]);

  if (dateKeys.length === 0) return null;

  const hasData = agg.totalReleased > 0;

  return (
    <div className="admin-insights">
      <div className="ai-header">
        <span className="ai-eyebrow">Admin</span>
        <h2 className="ai-title">Week at a glance</h2>
        <p className="ai-sub">Capacity + uptake for the current week view</p>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <div className="ai-kpi-strip">
        <StatCard
          label="Released"
          value={`${agg.totalReleased}h`}
          sub={`${agg.activeDays} active day${agg.activeDays !== 1 ? "s" : ""}`}
          accent="var(--amber)"
        />
        <StatCard
          label="Claimed"
          value={`${agg.totalClaimed}h`}
          sub={hasData ? `${agg.fillRate}% fill rate` : "—"}
          accent="var(--lime)"
        />
        <StatCard
          label="Remaining"
          value={`${agg.totalRemaining}h`}
          sub={hasData ? "still open" : "—"}
          accent="var(--sky)"
        />
        {busiestDay && (
          <StatCard
            label="Busiest day"
            value={`${busiestDay.hours}h`}
            sub={formatWeekdayShort(busiestDay.dk)}
            accent="var(--teal)"
          />
        )}
      </div>

      {!hasData ? (
        <div className="ai-empty">
          No capacity released this week yet. Use the panel above to release hours.
        </div>
      ) : (
        <>
          {/* ── Fill rate ring + bar ──────────────────────────────────── */}
          <div className="ai-fill-section">
            <RingChart
              fillPct={agg.fillRate}
              color={agg.fillRate >= 80 ? "var(--lime)" : agg.fillRate >= 40 ? "var(--amber)" : "var(--rust)"}
              size={72}
              stroke={9}
              label="Fill rate"
            />
            <div className="ai-fill-detail">
              <div className="ai-fill-row">
                <span className="ai-fill-swatch" style={{ background: "var(--amber)" }} />
                <span className="ai-fill-key">Released</span>
                <span className="ai-fill-val">{agg.totalReleased}h</span>
              </div>
              <div className="ai-fill-row">
                <span className="ai-fill-swatch" style={{ background: "var(--lime)" }} />
                <span className="ai-fill-key">Claimed</span>
                <span className="ai-fill-val">{agg.totalClaimed}h</span>
              </div>
              <div className="ai-fill-row">
                <span className="ai-fill-swatch" style={{ background: "var(--sky)" }} />
                <span className="ai-fill-key">Remaining</span>
                <span className="ai-fill-val">{agg.totalRemaining}h</span>
              </div>
              <FillBar fillPct={pct(agg.totalClaimed, agg.totalReleased)} color="var(--lime)" height={6} />
            </div>
          </div>

          {/* ── Per-day bar chart ─────────────────────────────────────── */}
          <div className="ai-section">
            <span className="ai-section-label">Daily breakdown</span>
            <DayBars
              dateKeys={dateKeys}
              weekData={weekData}
              projectFilter={projectFilter}
            />
            <div className="ai-bar-legend">
              <span><span className="ai-bar-swatch ai-bar-swatch--rel" /> Released</span>
              <span><span className="ai-bar-swatch ai-bar-swatch--cls" /> Claimed</span>
            </div>
          </div>

          {/* ── Per-project rows ──────────────────────────────────────── */}
          {allProjectNames.length > 0 && (
            <div className="ai-section">
              <span className="ai-section-label">By project</span>
              <div className="ai-project-list">
                {allProjectNames.map((name) => {
                  const d = agg.byProject[name] ?? { released: 0, claimed: 0 };
                  return (
                    <ProjectRow
                      key={name}
                      name={name}
                      released={d.released}
                      claimed={d.claimed}
                      remaining={Math.max(0, d.released - d.claimed)}
                      allNames={allProjectNames}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

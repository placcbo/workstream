import {
  DAY_START_HOUR,
  SLOTS_PER_DAY,
  assignBlockLanes,
  formatDayNumber,
  formatWeekdayShort,
  slotIndexToLabel,
} from "../data/schedule";

const ROW_HEIGHT = 34;

export default function WeekGrid({
  dateKeys,
  weekData,
  pendingClaim,
  projectFilter,
  onSelectBlock,
  onCancelBooking,
  visibleLayers,
  todayKey,
  isAdmin,
  onRevokeBlock,
  disabled,
}) {
  const maxRows = Math.max(
    SLOTS_PER_DAY,
    ...dateKeys.flatMap((dateKey) =>
      (weekData[dateKey]?.blocks ?? []).map((block) => block.startSlot + Math.ceil(block.totalHours))
    )
  );

  return (
    <div className="week-grid week-grid--released" style={{ "--ledger-rows": maxRows }}>
      <div className="week-grid-corner" />
      <div className="week-grid-day-headers">
        {dateKeys.map((dateKey) => (
          <div key={dateKey} className={`week-grid-day-header ${dateKey === todayKey ? "is-today" : ""}`}>
            <span className="week-grid-weekday">{formatWeekdayShort(dateKey)}</span>
            <span className="week-grid-daynum">{formatDayNumber(dateKey)}</span>
          </div>
        ))}
      </div>

      <div className="week-grid-hour-rail">
        {Array.from({ length: maxRows }, (_, row) => (
          <div key={row} className="week-grid-hour-label" style={{ height: ROW_HEIGHT }}>
            {slotIndexToLabel(row % SLOTS_PER_DAY)}
          </div>
        ))}
      </div>

      <div className="week-grid-columns">
        {dateKeys.map((dateKey) => {
          const dayInfo = weekData[dateKey] ?? { blocks: [], summary: { releasedHours: 0, reservedHours: 0, remainingHours: 0 } };
        const filteredBlocks = projectFilter ? dayInfo.blocks.filter((block) => block.workType === projectFilter) : dayInfo.blocks;
        // Only blocks that will actually be rendered as buttons should
        // compete for lanes — a block hidden by the layer toggles (for
        // non-admins) shouldn't reserve width that a visible block could use.
        const renderableBlocks = filteredBlocks.filter((block) => {
          if (!isAdmin) {
            const hasMyReservation = block.myHours > 0;
            if ((block.remainingHours ?? 0) <= 0 && !hasMyReservation) return false;
          }
          const showOpen = visibleLayers.has("open") && block.remainingHours > 0;
          const showReserved = visibleLayers.has("reserved") && block.reservedHours > 0;
          return showOpen || showReserved || isAdmin;
        });
        const laneLayout = assignBlockLanes(renderableBlocks);
        const daySummary = projectFilter
          ? filteredBlocks.reduce(
              (summary, block) => {
                summary.releasedHours += block.totalHours;
                summary.reservedHours += block.reservedHours ?? 0;
                summary.remainingHours += Math.max(0, block.remainingHours ?? 0);
                return summary;
              },
              { releasedHours: 0, reservedHours: 0, remainingHours: 0 }
            )
          : dayInfo.summary;
        // For workers, the day summary should reflect THEIR OWN claimed
        // hours against THEIR OWN per-block cap — not the admin's
        // shared-pool totals (e.g. "32h reserved" out of a 50h block makes
        // no sense to a worker capped at 8h on that block). Sum each
        // block's myHours and maxHoursPerUser instead. Scoped to the same
        // visible-to-worker set as the block tiles below, so an exhausted
        // block the worker never touched doesn't inflate "myCap" or trigger
        // the summary to render for an otherwise-empty day.
        const visibleBlocksForWorker = isAdmin
          ? filteredBlocks
          : filteredBlocks.filter((block) => (block.remainingHours ?? 0) > 0 || (block.myHours ?? 0) > 0);
        const myDaySummary = visibleBlocksForWorker.reduce(
          (summary, block) => {
            const cap = block.maxHoursPerUser > 0 ? block.maxHoursPerUser : 8;
            summary.myHours += block.myHours ?? 0;
            summary.myCap += cap;
            return summary;
          },
          { myHours: 0, myCap: 0 }
        );
          return (
            <div key={dateKey} className="week-grid-column">
              {Array.from({ length: maxRows }, (_, row) => (
                <div key={row} className="week-grid-cell" style={{ height: ROW_HEIGHT }} />
              ))}

              {(isAdmin ? filteredBlocks.length > 0 : visibleBlocksForWorker.length > 0) && (
                <div className="week-grid-day-summary">
                  {isAdmin ? (
                    <>
                      <strong>{daySummary.releasedHours}h released</strong>
                      <span>
                        {daySummary.reservedHours}h reserved • {daySummary.remainingHours}h remaining
                      </span>
                    </>
                  ) : myDaySummary.myCap > 0 ? (
                    <span>
                      {myDaySummary.myHours}h of {myDaySummary.myCap}h claimed
                    </span>
                  ) : null}
                </div>
              )}

              {filteredBlocks.map((block) => {
                const hasMyReservation = !isAdmin && block.myHours > 0;
                // A block with no remaining capacity (fully claimed, by
                // anyone) should be hidden from workers entirely unless
                // they personally have hours claimed on it — there's
                // nothing left for them to do with an exhausted block they
                // never touched, so showing it as a full-day "0h of 8h"
                // tile is just noise.
                if (!isAdmin && (block.remainingHours ?? 0) <= 0 && !hasMyReservation) return null;

                const showOpen = visibleLayers.has("open") && block.remainingHours > 0;
                const showReserved = visibleLayers.has("reserved") && block.reservedHours > 0;
                if (!showOpen && !showReserved && !isAdmin) return null;

                const isUserReserved = !isAdmin && (hasMyReservation || block.remainingHours <= 0);

                const startHour = Number.parseInt((block.startTime ?? "08:00").split(":")[0], 10);
                const startMin  = Number.parseInt(((block.startTime ?? "08:00").split(":")[1]) ?? "0", 10);
                const endHour   = Number.parseInt((block.endTime   ?? "17:00").split(":")[0], 10);
                const endMin    = Number.parseInt(((block.endTime   ?? "17:00").split(":")[1]) ?? "0", 10);
                // Has this block's shift window already ended? Mirrors the
                // overnight-aware logic in BoardPage.jsx's getShiftWindow —
                // a shift like 22:00->02:00 rolls its end time to the next
                // calendar day rather than being treated as already over.
                const isShiftOver = (() => {
                  const [year, month, day] = dateKey.split("-").map(Number);
                  const startMinutesOfDay = startHour * 60 + startMin;
                  const endMinutesOfDay = endHour * 60 + endMin;
                  const dayOffset = endMinutesOfDay > startMinutesOfDay ? 0 : 1;
                  const end = new Date(year, month - 1, day + dayOffset, endHour, endMin, 0, 0);
                  return new Date() > end;
                })();
                // Visual height = shift window (startTime→endTime), NOT totalHours.
                // totalHours is the capacity pool (e.g. 50h across many workers).
                const startMins = startHour * 60 + startMin;
                const endMinsRaw = endHour * 60 + endMin;
                const durationMins = endMinsRaw > startMins ? endMinsRaw - startMins : (24 * 60 - startMins + endMinsRaw);
                const durationHours = Math.max(1, durationMins / 60);
                const top = Math.max(0, (startHour - DAY_START_HOUR) * ROW_HEIGHT + (startMin / 60) * ROW_HEIGHT);
                const height = Math.max(ROW_HEIGHT, durationHours * ROW_HEIGHT);
                const reservedPct = block.totalHours > 0 ? Math.min(100, ((isAdmin ? block.reservedHours : block.myHours) / block.totalHours) * 100) : 0;
                const isSelected = pendingClaim?.blockId === block.id;
                const isNewOpportunity = block.remainingHours > 0;

                // Side-by-side placement: blocks that overlap in time (e.g.
                // from two different admins/projects) split the column width
                // across lanes instead of stacking on top of one another.
                // Outer edges keep the original 6px gutter; lanes are
                // separated from each other by a 4px gap (half on each side).
                const { lane, laneCount } = laneLayout.get(block.id) ?? { lane: 0, laneCount: 1 };
                const GUTTER = 6;
                const LANE_GAP = 4;
                const totalGutters = GUTTER * 2 + LANE_GAP * (laneCount - 1);
                const laneWidth = `calc((100% - ${totalGutters}px) / ${laneCount})`;
                const laneLeft = `calc(${GUTTER}px + ${lane} * (${laneWidth} + ${LANE_GAP}px))`;

                return (
                  <button
                    key={block.id}
                    className={[
                      "calendar-capacity-block",
                      isAdmin && "calendar-capacity-block--admin",
                      hasMyReservation ? "calendar-capacity-block--mine" : isNewOpportunity ? "calendar-capacity-block--open" : "calendar-capacity-block--reserved",
                      block.isFull && "calendar-capacity-block--full",
                      isSelected && "calendar-capacity-block--selected",
                      !isAdmin && isShiftOver && "calendar-capacity-block--completed",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{
                      top,
                      height,
                      left: laneLeft,
                      width: laneWidth,
                      right: "auto",
                    }}
                    data-work-type={block.workType}
                    disabled={disabled || (!isAdmin && ((!block.myHours && block.remainingHours <= 0) || isShiftOver))}
                    title={!isAdmin && isShiftOver ? "This shift has ended and can no longer be modified." : undefined}
                    onClick={() => onSelectBlock(dateKey, block)}
                  >
                    <span className="calendar-capacity-fill" style={{ height: `${reservedPct}%` }} />
                    <span className="calendar-capacity-content">
                      <span className="calendar-capacity-title-row">
                        <span className="calendar-capacity-title">{block.shiftName || block.workType || "Shift"}</span>
                        {block.workType && <span className="calendar-capacity-project-chip">{block.workType}</span>}
                      </span>
                      {isAdmin && <span className="calendar-capacity-admin-hint">Tap to reduce</span>}
                      <span className="calendar-capacity-stack">
                        {isAdmin ? (
                          <>
                            <span className="calendar-capacity-claimed">{`${block.totalHours}h total`}</span>
                            <span className="calendar-capacity-remaining">{block.remainingHours}h available</span>
                          </>
                        ) : hasMyReservation ? (
                          <span className="calendar-capacity-claimed">
                            {`${block.myHours || 0}h of ${block.maxHoursPerUser > 0 ? block.maxHoursPerUser : 8}h claimed`}
                          </span>
                        ) : (
                          <span className="calendar-capacity-claimed">
                            {`0h of ${block.maxHoursPerUser > 0 ? block.maxHoursPerUser : 8}h`}
                          </span>
                        )}
                      </span>
                      {!isAdmin && <span className="calendar-capacity-times">{block.startTime} - {block.endTime}</span>}
                    </span>
                    {!isAdmin && !isShiftOver && <span className="calendar-capacity-edge" aria-hidden="true">⋯</span>}
                  </button>
                );
              })}

              {isAdmin &&
                dayInfo.blocks.map((block) =>
                  block.reservedHours === 0 ? (
                    <button
                      key={`remove-${block.id}`}
                      className="calendar-remove-block"
                      style={{ top: block.startSlot * ROW_HEIGHT + 4 }}
                      onClick={() => onRevokeBlock(dateKey, block.id)}
                    >
                      Remove
                    </button>
                  ) : null
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
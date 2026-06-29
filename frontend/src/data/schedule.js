// ---------------------------------------------------------------------------
// Schedule domain model
//
// The "work day" runs 08:00 -> 08:00 the next calendar day (24 one-hour slots).
// Slot index 0 = 08:00-09:00 ... slot index 23 = 07:00-08:00 (next day).
//
// This shape is intentionally flat and serializable so it maps directly onto
// future Postgres tables:
//   availability_slots(id, work_date, slot_index, status, created_by)
//   bookings(id, user_id, work_date, slot_index, created_at)
// ---------------------------------------------------------------------------

export const DAY_START_HOUR = 8; // work day starts at 08:00
export const SLOTS_PER_DAY = 24;
export const MAX_HOURS_PER_DAY = 8;

export const SLOT_STATUS = {
  CLOSED: "closed", // admin has not released this hour
  OPEN: "open", // admin released it, nobody booked it yet
  BOOKED: "booked", // someone has reserved it
};

/** A booking's lifecycle: reserved until its end time passes, then completed. */
export const BOOKING_STATUS = {
  RESERVED: "reserved", // upcoming or in-progress shift
  COMPLETED: "completed", // shift's end time has passed
};

/** Convert a slot index (0-23) to a display label like "08:00" or "23:00". */
export function slotIndexToLabel(slotIndex) {
  const hour = (DAY_START_HOUR + slotIndex) % 24;
  return `${String(hour).padStart(2, "0")}:00`;
}

/** True if this slot index falls on the *next* calendar day (after midnight). */
export function isOvernightSlot(slotIndex) {
  return DAY_START_HOUR + slotIndex >= 24;
}

/**
 * The real calendar Date+hour a given (dateKey, slotIndex) ends at, accounting
 * for the 08:00-start, overnight-rollover work day. Used to decide whether a
 * booking has already happened (completed) or is still upcoming (reserved).
 */
export function slotEndDateTime(dateKey, slotIndex) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const endHourAbsolute = DAY_START_HOUR + slotIndex + 1; // hour *after* this slot
  const dayOffset = Math.floor(endHourAbsolute / 24);
  const hourOfDay = endHourAbsolute % 24;
  return new Date(y, m - 1, d + dayOffset, hourOfDay, 0, 0, 0);
}

/** Derive RESERVED vs COMPLETED for a booking by comparing its end time to now. */
export function deriveBookingStatus(dateKey, slotIndex, now = new Date()) {
  return slotEndDateTime(dateKey, slotIndex) <= now ? BOOKING_STATUS.COMPLETED : BOOKING_STATUS.RESERVED;
}

/** Format a Date as YYYY-MM-DD for use as a work_date key. */
export function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Build an array of `count` consecutive date keys starting from `startDate`. */
export function buildDateRange(startDate, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    out.push(toDateKey(d));
  }
  return out;
}

export function formatDateHeading(dateKey) {
  const d = new Date(`${dateKey}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** "Sun" / "Mon" short weekday label. */
export function formatWeekdayShort(dateKey) {
  const d = new Date(`${dateKey}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

/** "21" day-of-month number. */
export function formatDayNumber(dateKey) {
  return new Date(`${dateKey}T00:00:00`).getDate();
}

/** The Sunday that starts the week containing `date`. */
export function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

/** Build the 7 date keys (Sun -> Sat) for the week containing `date`. */
export function buildWeekRange(date) {
  return buildDateRange(startOfWeek(date), 7);
}

/**
 * Build a 6x7 grid of date keys for the mini month calendar, including
 * leading/trailing days from adjacent months so every week row is full.
 */
export function buildMonthGrid(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const gridStart = startOfWeek(firstOfMonth);
  const cells = buildDateRange(gridStart, 42);
  return cells.map((dateKey) => ({
    dateKey,
    inMonth: new Date(`${dateKey}T00:00:00`).getMonth() === month,
  }));
}

export function formatMonthHeading(year, month) {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Block layout
//
// A single day can have blocks released by different admins for different
// projects. A user (or admin) viewing that day may have several of those
// visible at once, and their time ranges can overlap — e.g. two admins both
// release an 08:00-16:00 block for their own project. Rendering every block
// at full column width would make all but the topmost one invisible, so we
// assign each block a "lane" (classic interval-scheduling / calendar layout):
// blocks that don't overlap in time can each take full width, while blocks
// that DO overlap split the available width evenly across however many lanes
// are needed at that point in time.
// ---------------------------------------------------------------------------

const ROW_HEIGHT_FOR_LAYOUT = 34;

/**
 * Returns a Map from block.id -> { lane, laneCount } describing how each
 * block should be horizontally positioned within its day column.
 *
 * `rowHeight` should match whatever pixel height the caller uses per hour
 * row (defaults to the WeekGrid's ROW_HEIGHT) — it only affects the relative
 * start/end values used to detect overlap, not the externally visible shape.
 */
export function assignBlockLanes(blocks, rowHeight = ROW_HEIGHT_FOR_LAYOUT) {
  const layout = new Map();
  if (blocks.length === 0) return layout;

  const withRange = blocks.map((block) => {
    const startHour = Number.parseInt((block.startTime ?? "08:00").split(":")[0], 10);
    const start = Math.max(0, (startHour - DAY_START_HOUR) * rowHeight);
    const span = Math.max(rowHeight, Math.max(1, Number(block.totalHours) || 1) * rowHeight);
    return { block, start, end: start + span };
  });

  // Sort by start time so lanes fill left-to-right in chronological order.
  withRange.sort((a, b) => a.start - b.start || a.end - b.end);

  // Cluster blocks into groups of mutually-overlapping blocks (connected
  // intervals), then assign lanes within each cluster independently so a
  // block far away in time doesn't get squeezed by an unrelated overlap.
  const clusters = [];
  let current = [];
  let currentEnd = -Infinity;
  withRange.forEach((entry) => {
    if (current.length > 0 && entry.start >= currentEnd) {
      clusters.push(current);
      current = [];
      currentEnd = -Infinity;
    }
    current.push(entry);
    currentEnd = Math.max(currentEnd, entry.end);
  });
  if (current.length > 0) clusters.push(current);

  clusters.forEach((cluster) => {
    const laneEnds = []; // laneEnds[i] = end time currently occupied in lane i
    cluster.forEach((entry) => {
      let lane = laneEnds.findIndex((end) => entry.start >= end);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(entry.end);
      } else {
        laneEnds[lane] = entry.end;
      }
      entry.lane = lane;
    });
    const laneCount = laneEnds.length;
    cluster.forEach((entry) => {
      layout.set(entry.block.id, { lane: entry.lane, laneCount });
    });
  });

  return layout;
}
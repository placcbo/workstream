// ---------------------------------------------------------------------------
// Mock backend.
//
// This version models released capacity as admin-created blocks. An admin
// releases a total number of hours for a day and chooses the block size used
// to split that capacity. Users claim hours from a block; the block remains
// available until its remaining hours reaches 0.
// ---------------------------------------------------------------------------

import {
  buildDateRange,
  buildWeekRange,
  toDateKey,
  BOOKING_STATUS,
  deriveBookingStatus,
  slotIndexToLabel,
  MAX_HOURS_PER_DAY,
} from "./schedule.js";

const NETWORK_DELAY_MS = 20;

function delay(value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), NETWORK_DELAY_MS));
}

const today = new Date();

const releaseBlocks = new Map();
let bookings = [];
let nextBlockId = 100;
let nextBookingId = 100;

function blockEndSlot(block) {
  return block.startSlot + Math.max(1, Math.ceil(block.totalHours)) - 1;
}

function bookingHours(booking) {
  return booking.hours;
}

function getBlockBookings(blockId) {
  return bookings.filter((booking) => booking.blockId === blockId);
}

function reservedForBlock(blockId) {
  return getBlockBookings(blockId).reduce((sum, booking) => sum + booking.hours, 0);
}

function remainingForBlock(block) {
  return Math.max(0, block.totalHours - reservedForBlock(block.id));
}

function buildBlocks(totalHours, blockSize, startSlot) {
  const blocks = [];
  let remaining = totalHours;
  let cursor = startSlot;
  while (remaining > 0) {
    const hours = Math.min(blockSize, remaining);
    blocks.push({
      startSlot: cursor,
      totalHours: hours,
      blockSize,
    });
    remaining -= hours;
    cursor += Math.ceil(hours);
  }
  return blocks;
}

function addRelease(dateKey, totalHours, blockSize, startSlot = 0, shiftName = "Extraction Experienced", startTime = "08:00", endTime = "17:00", workType = "Extraction", ownerId = "", maxHoursPerUser = 8) {
  const current = releaseBlocks.get(dateKey) ?? [];
  const created = buildBlocks(totalHours, blockSize, startSlot).map((block) => ({
    id: `rb-${nextBlockId++}`,
    dateKey,
    ...block,
    shiftName,
    startTime,
    endTime,
    workType,
    ownerId,
    maxHoursPerUser,
  }));
  releaseBlocks.set(dateKey, current.concat(created));
  return created;
}

function serializeBlock(block, currentUserId) {
  const blockBookings = getBlockBookings(block.id);
  const reservedHours = blockBookings.reduce((sum, booking) => sum + booking.hours, 0);
  const remainingHours = Math.max(0, block.totalHours - reservedHours);
  const endSlot = blockEndSlot(block);
  return {
    ...block,
    label: `${slotIndexToLabel(block.startSlot)} start`,
    endSlot,
    reservedHours,
    remainingHours,
    isFull: remainingHours <= 0,
    myHours: blockBookings
      .filter((booking) => booking.userId === currentUserId)
      .reduce((sum, booking) => sum + booking.hours, 0),
    bookings: blockBookings.map((booking) => ({
      ...booking,
      isMine: booking.userId === currentUserId,
      status: deriveBookingStatus(booking.dateKey, endSlot),
    })),
  };
}

function summarizeDate(dateKey, blocks = null) {
  const sourceBlocks = blocks ?? releaseBlocks.get(dateKey) ?? [];
  const releasedHours = sourceBlocks.reduce((sum, block) => sum + block.totalHours, 0);
  const reservedHours = sourceBlocks.reduce((sum, block) => sum + reservedForBlock(block.id), 0);
  return {
    releasedHours,
    reservedHours,
    remainingHours: Math.max(0, releasedHours - reservedHours),
  };
}

function blockWorkType(dateKey, blockId) {
  const block = (releaseBlocks.get(dateKey) ?? []).find((candidate) => candidate.id === blockId);
  return block?.workType ?? null;
}

/**
 * Sum of a user's claimed hours on `dateKey`, scoped to bookings whose block
 * has the given `workType`. The 8h/day cap applies per project, so a user
 * granted both Extraction and Cooking can claim up to the cap in EACH,
 * independently, on the same day. `excludeBookingId` lets callers exclude
 * the booking currently being edited (for updateBookingHours).
 */
function userHoursForDayAndWorkType(dateKey, userId, workType, excludeBookingId = null) {
  return bookings
    .filter(
      (booking) =>
        booking.dateKey === dateKey &&
        booking.userId === userId &&
        booking.id !== excludeBookingId &&
        blockWorkType(dateKey, booking.blockId) === workType
    )
    .reduce((sum, booking) => sum + bookingHours(booking), 0);
}

export function fetchVisibleDateRange(days = 7) {
  return delay(buildDateRange(today, days));
}

export function fetchWeekRange(anchorDate) {
  return delay(buildWeekRange(anchorDate));
}

export function fetchDaySchedule(dateKey, currentUserId) {
  return delay((releaseBlocks.get(dateKey) ?? []).map((block) => serializeBlock(block, currentUserId)));
}

/**
 * `userWorkTypes` is the array of project types this user is allowed to see
 * (their default type(s) plus anything an admin has granted them). Admins
 * pass null to bypass the filter entirely and see every block.
 *
 * FIX (Bug 1): Previously `grantedTypes.length === 0` fell through to the
 * unfiltered path, so a user with no granted projects saw ALL blocks. Now:
 *   - null  → no filter (admin path)
 *   - []    → show nothing (user with no granted projects)
 *   - [..] → show only matching blocks
 */
export function fetchWeekSchedule(dateKeys, currentUserId, isAdmin = false, userWorkTypes = null) {
  const byDate = {};
  const grantedTypes = isAdmin ? null : (Array.isArray(userWorkTypes) ? userWorkTypes : null);
  dateKeys.forEach((dateKey) => {
    const blocks = (releaseBlocks.get(dateKey) ?? []).map((block) => serializeBlock(block, currentUserId));
    const visibleBlocks = blocks.filter((block) => {
      if (isAdmin) {
        return block.ownerId === currentUserId;
      }
      if (grantedTypes === null) return true;
      return grantedTypes.includes(block.workType);
    });
    byDate[dateKey] = {
      blocks: visibleBlocks,
      summary: summarizeDate(dateKey, visibleBlocks),
    };
  });
  return delay(byDate);
}

export function fetchUserHoursForDay(dateKey, userId, workType = null) {
  const total = bookings
    .filter(
      (booking) =>
        booking.dateKey === dateKey &&
        booking.userId === userId &&
        (workType == null || blockWorkType(dateKey, booking.blockId) === workType)
    )
    .reduce((sum, booking) => sum + bookingHours(booking), 0);
  return delay(total);
}

export function fetchUserHoursSummary(dateKeys, userId) {
  const dateSet = new Set(dateKeys);
  const userBookings = bookings.filter((booking) => booking.userId === userId && dateSet.has(booking.dateKey));
  let reportedHours = 0;
  let reservedHours = 0;
  userBookings.forEach((booking) => {
    const block = (releaseBlocks.get(booking.dateKey) ?? []).find((candidate) => candidate.id === booking.blockId);
    const endSlot = block ? blockEndSlot(block) : 0;
    reservedHours += booking.hours;
    if (deriveBookingStatus(booking.dateKey, endSlot) === BOOKING_STATUS.COMPLETED) {
      reportedHours += booking.hours;
    }
  });
  return delay({ reportedHours, reservedHours });
}

export function fetchAdminCapacitySummary(dateKeys) {
  const byDate = {};
  dateKeys.forEach((dateKey) => {
    byDate[dateKey] = summarizeDate(dateKey);
  });
  return delay(byDate);
}

export function releaseHours(dateKey, totalHours, blockSize, startSlot = 0, shiftName = "Extraction Experienced", startTime = "08:00", endTime = "17:00", workType = "Extraction", ownerId = "", maxHoursPerUser = 8) {
  const normalizedTotal = Math.max(1, Number(totalHours) || 1);
  const normalizedBlockSize = Math.max(1, Number(blockSize) || 1);
  const created = addRelease(
    dateKey,
    normalizedTotal,
    normalizedBlockSize,
    Number(startSlot) || 0,
    shiftName,
    startTime,
    endTime,
    workType,
    ownerId,
    Number(maxHoursPerUser) || 8
  );
  return delay({ ok: true, created });
}

/**
 * Adjust a SINGLE existing block's total hours (identified by `blockId`).
 * Only touches the one block; every other block for that day (any project)
 * is left untouched.
 */
export function adjustReleasedHours(dateKey, blockId, totalHours, shiftName, startTime, endTime, workType, maxHoursPerUser) {
  const current = releaseBlocks.get(dateKey) ?? [];
  const target = current.find((block) => block.id === blockId);
  if (!target) return delay({ ok: false, error: "Block not found." });

  const normalizedTotal = Math.max(1, Number(totalHours) || 1);
  const reserved = reservedForBlock(target.id);
  if (normalizedTotal < reserved) {
    return delay({
      ok: false,
      error: `Can't reduce below ${reserved}h — that's already claimed on this block.`,
    });
  }

  const updatedBlock = {
    ...target,
    totalHours: normalizedTotal,
    blockSize: normalizedTotal,
    shiftName: shiftName ?? target.shiftName,
    startTime: startTime ?? target.startTime,
    endTime: endTime ?? target.endTime,
    workType: workType ?? target.workType,
    maxHoursPerUser: Number(maxHoursPerUser) || target.maxHoursPerUser || 8,
  };
  releaseBlocks.set(
    dateKey,
    current.map((block) => (block.id === blockId ? updatedBlock : block))
  );
  return delay({ ok: true, updated: updatedBlock });
}

export function revokeBlock(dateKey, blockId) {
  if (reservedForBlock(blockId) > 0) {
    return delay({ ok: false, error: "This block already has reservations." });
  }
  const current = releaseBlocks.get(dateKey) ?? [];
  releaseBlocks.set(
    dateKey,
    current.filter((block) => block.id !== blockId)
  );
  return delay({ ok: true });
}

export function reserveHours(dateKey, blockId, hours, userId, maxHoursPerDay) {
  const block = (releaseBlocks.get(dateKey) ?? []).find((candidate) => candidate.id === blockId);
  if (!block) return delay({ ok: false, error: "Block not found." });

  const claimHours = Math.max(1, Number(hours) || 1);
  const remainingHours = remainingForBlock(block);
  if (claimHours > remainingHours) {
    return delay({ ok: false, error: `Only ${remainingHours}h remain in this block.` });
  }

  // Cap is per project (workType), not combined across every project the
  // user has access to — e.g. 8h Extraction + 8h Cooking is allowed.
  const perProjectMax = block.maxHoursPerUser > 0 ? block.maxHoursPerUser : maxHoursPerDay;
  const existingForUserInProject = userHoursForDayAndWorkType(dateKey, userId, block.workType);
  if (existingForUserInProject + claimHours > perProjectMax) {
    return delay({
      ok: false,
      error: `That would put you at ${existingForUserInProject + claimHours}h of ${block.workType} today; the max is ${perProjectMax}h/day per project.`,
    });
  }

  const created = {
    id: `b-${nextBookingId++}`,
    userId,
    dateKey,
    blockId,
    hours: claimHours,
  };
  bookings = bookings.concat(created);
  return delay({ ok: true, created });
}

export function updateBookingHours(bookingId, hours, userId, maxHoursPerDay = MAX_HOURS_PER_DAY) {
  const target = bookings.find((booking) => booking.id === bookingId);
  if (!target) return delay({ ok: false, error: "Booking not found." });
  if (target.userId !== userId) return delay({ ok: false, error: "Not your booking." });

  const normalizedHours = Number(hours);
  if (!Number.isFinite(normalizedHours) || normalizedHours < 0) {
    return delay({ ok: false, error: "Hours must be 0 or more." });
  }

  if (normalizedHours === 0) {
    bookings = bookings.filter((booking) => booking.id !== bookingId);
    return delay({ ok: true, cancelled: true, booking: target });
  }

  const block = (releaseBlocks.get(target.dateKey) ?? []).find((candidate) => candidate.id === target.blockId);
  const otherBookingsOnBlock = bookings.filter((booking) => booking.dateKey === target.dateKey && booking.blockId === target.blockId && booking.id !== bookingId);
  const otherUserHoursOnDayInProject = userHoursForDayAndWorkType(target.dateKey, userId, block?.workType, bookingId);
  const blockCapacityRemaining = block ? Math.max(0, block.totalHours - otherBookingsOnBlock.reduce((sum, booking) => sum + bookingHours(booking), 0)) : Number.POSITIVE_INFINITY;
  const perProjectMax = block?.maxHoursPerUser > 0 ? block.maxHoursPerUser : maxHoursPerDay;
  const dailyCapacityRemaining = Math.max(0, perProjectMax - otherUserHoursOnDayInProject);
  const maxAllowedHours = Math.min(blockCapacityRemaining, dailyCapacityRemaining);

  if (normalizedHours > maxAllowedHours) {
    return delay({ ok: false, error: `Only ${maxAllowedHours}h are available for this booking.` });
  }

  if (normalizedHours === target.hours) {
    return delay({ ok: true, updated: false, booking: target });
  }

  bookings = bookings.map((booking) => (booking.id === bookingId ? { ...booking, hours: normalizedHours } : booking));
  return delay({ ok: true, updated: true, booking: { ...target, hours: normalizedHours } });
}

export function cancelBooking(bookingId, userId) {
  const target = bookings.find((booking) => booking.id === bookingId);
  if (!target) return delay({ ok: false, error: "Booking not found." });
  if (target.userId !== userId) return delay({ ok: false, error: "Not your booking." });

  const block = (releaseBlocks.get(target.dateKey) ?? []).find((candidate) => candidate.id === target.blockId);
  const endSlot = block ? blockEndSlot(block) : 0;
  if (deriveBookingStatus(target.dateKey, endSlot) === BOOKING_STATUS.COMPLETED) {
    return delay({ ok: false, error: "Can't cancel a shift that already happened." });
  }

  bookings = bookings.filter((booking) => booking.id !== bookingId);
  return delay({ ok: true });
}

export { toDateKey };
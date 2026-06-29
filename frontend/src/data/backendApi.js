const BASE_URL = "/api";

async function callApi(path, body, method = "POST") {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return response.json();
}

async function getApi(path) {
  const response = await fetch(`${BASE_URL}${path}`);
  return response.json();
}

export function fetchWeekRange(anchorDate) {
  return getApi(`/week-range?anchorDate=${encodeURIComponent(anchorDate.toISOString().slice(0, 10))}`);
}

export function fetchWeekSchedule(dateKeys, userId, isAdmin = false, userWorkTypes = null) {
  return callApi(`/week-schedule`, { dateKeys, userId, isAdmin, userWorkTypes });
}

export function fetchUserHoursForDay(dateKey, userId, workType = null) {
  const query = new URLSearchParams({ dateKey, userId });
  if (workType != null) query.set("workType", workType);
  return getApi(`/user-hours?${query.toString()}`);
}

export function fetchUserHoursSummary(dateKeys, userId) {
  return callApi(`/user-hours-summary`, { dateKeys, userId });
}

export function fetchAdminCapacitySummary(dateKeys) {
  return callApi(`/admin-capacity-summary`, { dateKeys });
}

export function releaseHours(dateKey, totalHours, blockSize, startSlot = 0, shiftName = "Extraction Experienced", startTime = "08:00", endTime = "17:00", workType = "Extraction", ownerId = "", maxHoursPerUser = 8) {
  return callApi(`/release-hours`, {
    dateKey,
    totalHours,
    blockSize,
    startSlot,
    shiftName,
    startTime,
    endTime,
    workType,
    ownerId,
    maxHoursPerUser,
  });
}

export function adjustReleasedHours(dateKey, blockId, totalHours, shiftName, startTime, endTime, workType, maxHoursPerUser) {
  return callApi(`/adjust-released-hours`, {
    dateKey,
    blockId,
    totalHours,
    shiftName,
    startTime,
    endTime,
    workType,
    maxHoursPerUser,
  });
}

export function revokeBlock(dateKey, blockId) {
  return callApi(`/revoke-block`, { dateKey, blockId });
}

export function reserveHours(dateKey, blockId, hours, userId, maxHoursPerDay) {
  return callApi(`/reserve-hours`, { dateKey, blockId, hours, userId, maxHoursPerDay });
}

export function updateBookingHours(bookingId, hours, userId, maxHoursPerDay = 8) {
  return callApi(`/update-booking-hours`, { bookingId, hours, userId, maxHoursPerDay });
}

export function cancelBooking(bookingId, userId) {
  return callApi(`/cancel-booking`, { bookingId, userId });
}

export { toDateKey } from "./schedule";

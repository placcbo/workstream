const BASE_URL = "https://diagnostic-epinions-obtaining-density.trycloudflare.com/api";

async function readResponsePayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  return text ? text : null;
}

async function callApi(path, body, method = "POST") {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  const payload = await readResponsePayload(response);
  if (!response.ok) {
    const errorMessage = payload && typeof payload === "object" && payload.error ? payload.error : typeof payload === "string" && payload ? payload : `Request failed with status ${response.status}`;
    const error = new Error(errorMessage);
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function getApi(path) {
  const response = await fetch(`${BASE_URL}${path}`);
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    const errorMessage = payload && typeof payload === "object" && payload.error ? payload.error : typeof payload === "string" && payload ? payload : `Request failed with status ${response.status}`;
    const error = new Error(errorMessage);
    error.status = response.status;
    throw error;
  }
  return payload;
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

// ── Projects (replaces a hardcoded http://localhost:8080 fetch in AuthContext.jsx) ──
export function fetchProjects(adminId) {
  return getApi(`/projects?adminId=${encodeURIComponent(adminId)}`);
}

export function addProject(adminId, name) {
  return callApi(`/projects`, { adminId, name });
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

// frequency: "daily" | "weekly" | "monthly". `weekdays` is an array of
// 0 (Sun) .. 6 (Sat), only used for daily/weekly — e.g. [1,2,3,4,5] for
// Mon-Fri, [1,2,3,4,5,6] for Mon-Sat. Ignored for monthly, which instead
// repeats on the same day-of-month as `startDate` until `endDate`.
export function releaseHoursRecurring({
  startDate,
  endDate,
  frequency,
  weekdays = [],
  totalHours,
  shiftName,
  startTime,
  endTime,
  workType,
  ownerId,
  maxHoursPerUser,
}) {
  return callApi(`/release-hours-recurring`, {
    startDate,
    endDate,
    frequency,
    weekdays,
    totalHours,
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

// ── Session (replaces localStorage "loggedInUser") ────────────────────────
export function registerAccount({ name, email, password, role = "user", inviteCode = "" }) {
  return callApi(`/register`, { name, email, password, role, inviteCode });
}

export function loginSession({ email, password }) {
  return callApi(`/session/login`, { email, password });
}

export function fetchSession(sessionId) {
  return getApi(`/session?sessionId=${encodeURIComponent(sessionId)}`);
}

export function logoutSession(sessionId) {
  return callApi(`/session/logout`, { sessionId });
}

// ── Work-type access grants (replaces localStorage "workTypeAccess") ──────
export function fetchWorkTypeAccess() {
  return getApi(`/work-type-access`);
}

export function grantWorkTypeAccess(email, workType) {
  return callApi(`/work-type-access/grant`, { email, workType });
}

export function revokeWorkTypeAccess(email, workType) {
  return callApi(`/work-type-access/revoke`, { email, workType });
}

// ── Work timer (replaces localStorage "timerState_*" / "reportedHoursOverride_*") ──
export function fetchActiveTimer(userId) {
  return getApi(`/timer?userId=${encodeURIComponent(userId)}`);
}

export function startTimer(userId, taskName, bookingId, blockId, dateKey) {
  return callApi(`/timer/start`, { userId, taskName, bookingId, blockId, dateKey });
}

export function stopTimer(userId, clientElapsedSeconds = null) {
  return callApi(`/timer/stop`, {
    userId,
    ...(clientElapsedSeconds != null ? { clientElapsedSeconds } : {}),
  });
}

export { toDateKey } from "./schedule.js";
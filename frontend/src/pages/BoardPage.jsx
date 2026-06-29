import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  cancelBooking,
  fetchUserHoursForDay,
  fetchUserHoursSummary,
  fetchWeekRange,
  fetchWeekSchedule,
  adjustReleasedHours,
  releaseHours,
  reserveHours,
  revokeBlock,
  updateBookingHours,
} from "../data/backendApi";
import { formatDateHeading, formatMonthHeading, MAX_HOURS_PER_DAY, toDateKey } from "../data/schedule";
import Header from "../components/Header";
import MiniMonth from "../components/MiniMonth";
import CalendarLayers from "../components/CalendarLayers";
import TimeInsights from "../components/TimeInsights";
import WeekGrid from "../components/WeekGrid";
import AdminReleasePanel from "../components/AdminReleasePanel";
import AdminProjectsAndUsers from "../components/AdminProjectsAndUsers";
import AdminInsights from "../components/AdminInsights";

const todayDate = new Date();
const todayKey = toDateKey(todayDate);

export default function BoardPage() {
  const { user, logout, workTypeAccess, grantWorkTypeAccess, revokeWorkTypeAccess, customWorkTypes, addCustomWorkType, clearCustomWorkTypes } = useAuth();
  const isAdmin = user.role === "admin";
  // Bug fix (Bug 2): admins have no defaultWorkTypes so grantedWorkTypes is
  // undefined → was passed as [] to fetchWeekSchedule, which (after fixing
  // Bug 1) would now show nothing. Pass null explicitly for admins so the API
  // skips filtering entirely.
  const grantedWorkTypes = isAdmin ? null : (user?.grantedWorkTypes ?? []);

  const [anchorDate, setAnchorDate] = useState(todayDate);
  const [monthCursor, setMonthCursor] = useState({ year: todayDate.getFullYear(), month: todayDate.getMonth() });
  const [dateKeys, setDateKeys] = useState([]);
  const [weekData, setWeekData] = useState({});
  const [pendingClaim, setPendingClaim] = useState(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [adminAdjustTarget, setAdminAdjustTarget] = useState(null);
  const [activeDate, setActiveDate] = useState(todayKey);
  const [committedHoursByWorkType, setCommittedHoursByWorkType] = useState({});
  const [summary, setSummary] = useState({ reportedHours: 0, reservedHours: 0 });
  const [visibleLayers, setVisibleLayers] = useState(new Set(["reserved", "completed", "open"]));
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState(null);
  const [adminProjectFilter, setAdminProjectFilter] = useState(null);
  const [highlightedProject, setHighlightedProject] = useState(null);
  const [showReservedBlocks, setShowReservedBlocks] = useState(false);
  const [timerElapsedSeconds, setTimerElapsedSeconds] = useState(0);
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerStartAt, setTimerStartAt] = useState(null);
  const [timerTaskName, setTimerTaskName] = useState("");
  const [reportedHoursOverride, setReportedHoursOverride] = useState(0);
  const [isRefreshingReserved, setIsRefreshingReserved] = useState(false);

  // Bug fix (Bug 3): clear admin modal state whenever the logged-in user
  // changes (e.g. admin-1 logs out and admin-2 logs in in the same tab).
  const prevUserId = useRef(user?.id);
  useEffect(() => {
    if (prevUserId.current !== user?.id) {
      prevUserId.current = user?.id;
      setAdminAdjustTarget(null);
      setPendingClaim(null);
      setCancelConfirmOpen(false);
      setBanner(null);
    }
  }, [user?.id]);

  // Bug fix (Bug 5): grantedWorkTypes is an array — a new array reference on
  // every render caused loadWeek to be recreated every render, which triggered
  // the useEffect below on every render (infinite loop). We stabilise it with
  // a ref so the callback only sees the latest value without it being a dep.
  const grantedWorkTypesRef = useRef(grantedWorkTypes);
  useEffect(() => { grantedWorkTypesRef.current = grantedWorkTypes; }, [grantedWorkTypes]);

  const loadWeek = useCallback(async (weekAnchorDate = anchorDate, showSpinner = false) => {
    if (showSpinner) {
      setLoading(true);
    }
    try {
      const keys = await fetchWeekRange(weekAnchorDate);
      setDateKeys(keys);
      const data = await fetchWeekSchedule(keys, user?.id ?? "", isAdmin, grantedWorkTypesRef.current);
      setWeekData(data);
      setSummary(await fetchUserHoursSummary(keys, user?.id ?? ""));
    } catch (err) {
      // Backend unreachable or network error — clear all volatile client state
      setDateKeys([]);
      setWeekData({});
      setSummary({ reportedHours: 0, reservedHours: 0 });
      setCommittedHoursByWorkType({});
      setBanner({ kind: "error", text: "Backend unreachable — cleared local state." });
    } finally {
      setLoading(false);
    }
  }, [anchorDate, user?.id, isAdmin]); // grantedWorkTypes accessed via ref — no array dep

  useEffect(() => {
    loadWeek(anchorDate, true);
  }, [anchorDate, loadWeek]);

  const handleAddWorkType = useCallback((name) => {
    addCustomWorkType(name);
    // Auto-select the project for admin quick-access and refresh insights
    setAdminProjectFilter(name);
    // Temporarily highlight the newly created tab
    setHighlightedProject(name);
    setTimeout(() => setHighlightedProject(null), 3500);
    // Refresh current week to reflect the new project in the data view.
    // Fire-and-forget: loadWeek handles its own errors.
    loadWeek(anchorDate, true);
  }, [loadWeek, anchorDate]);

  const handleAdminProjectFilterChange = useCallback((project) => {
    setAdminProjectFilter(project || null);
  }, []);

  // Lightweight backend liveness probe: if the backend becomes unreachable
  // we proactively clear all volatile client state to ensure nothing persists
  // while the server is down.
  useEffect(() => {
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        await fetchWeekRange(todayDate);
      } catch (err) {
        if (cancelled) return;
        setDateKeys([]);
        setWeekData({});
        setSummary({ reportedHours: 0, reservedHours: 0 });
        setCommittedHoursByWorkType({});
        clearCustomWorkTypes();
        setBanner({ kind: "error", text: "Backend unreachable — cleared local state." });
        clearInterval(interval);
      }
    }, 8000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  /** Committed hours for `activeDate`, scoped per project — refetched whenever the visible week data changes. */
  useEffect(() => {
    if (isAdmin || !grantedWorkTypes || grantedWorkTypes.length === 0) return;
    Promise.all(
      grantedWorkTypes.map((workType) =>
        fetchUserHoursForDay(activeDate, user?.id ?? "", workType).then((hours) => [workType, hours])
      )
    ).then((entries) => setCommittedHoursByWorkType(Object.fromEntries(entries)));
  }, [activeDate, user?.id, weekData, isAdmin, grantedWorkTypes]);

  const committedHoursForWorkType = useCallback(
    (workType) => committedHoursByWorkType[workType] ?? 0,
    [committedHoursByWorkType]
  );

  const effectiveReportedHours = summary.reportedHours + reportedHoursOverride;
  const reportedHoursOverrideLoaded = useRef(false);

  useEffect(() => {
    if (!user?.id) return;
    try {
      const stored = localStorage.getItem(`reportedHoursOverride_${user.id}`);
      setReportedHoursOverride(stored ? Number(stored) : 0);
    } catch {
      setReportedHoursOverride(0);
    } finally {
      reportedHoursOverrideLoaded.current = true;
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id || !reportedHoursOverrideLoaded.current) return;
    try {
      localStorage.setItem(`reportedHoursOverride_${user.id}`, String(reportedHoursOverride));
    } catch (err) {
      console.error("Failed to persist reported hours override", err);
    }
  }, [reportedHoursOverride, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    try {
      const stored = localStorage.getItem(`timerState_${user.id}`);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (parsed?.timerRunning && parsed?.timerStartAt) {
        const restoredSeconds = Math.max(0, Math.round((Date.now() - parsed.timerStartAt) / 1000));
        setTimerRunning(true);
        setTimerStartAt(parsed.timerStartAt);
        setTimerTaskName(parsed.timerTaskName ?? "");
        setTimerElapsedSeconds(restoredSeconds);
      }
    } catch (err) {
      console.error("Failed to restore timer state", err);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    try {
      const timerState = {
        timerRunning,
        timerStartAt,
        timerTaskName,
      };
      localStorage.setItem(`timerState_${user.id}`, JSON.stringify(timerState));
    } catch (err) {
      console.error("Failed to persist timer state", err);
    }
  }, [timerRunning, timerStartAt, timerTaskName, user?.id]);

  useEffect(() => {
    if (!showReservedBlocks) return;
    loadWeek(anchorDate, true);
  }, [showReservedBlocks, anchorDate, loadWeek]);

  const isNowInShiftWindow = useCallback((dateKey, startTime, endTime) => {
    if (!dateKey || !startTime || !endTime) return false;
    const [year, month, day] = dateKey.split("-").map(Number);
    const [startHour, startMinute] = startTime.split(":").map(Number);
    const [endHour, endMinute] = endTime.split(":").map(Number);
    const now = new Date();
    const start = new Date(year, month - 1, day, startHour, startMinute, 0, 0);
    const end = new Date(year, month - 1, day, endHour, endMinute, 0, 0);
    return now >= start && now <= end;
  }, []);

  const isShiftExpired = useCallback((dateKey, endTime) => {
    if (!dateKey || !endTime) return false;
    const [year, month, day] = dateKey.split("-").map(Number);
    const [endHour, endMinute] = endTime.split(":").map(Number);
    const end = new Date(year, month - 1, day, endHour, endMinute, 0, 0);
    return new Date() > end;
  }, []);

  const handleRefreshReservedBlocks = useCallback(async () => {
    setIsRefreshingReserved(true);
    setBanner(null);
    try {
      await loadWeek(anchorDate, true);
    } finally {
      setIsRefreshingReserved(false);
    }
  }, [anchorDate, loadWeek]);

  const userInitials = useMemo(() => {
    if (!user?.name) return "?";
    return user.name
      .split(" ")
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }, [user?.name]);

  const formatSeconds = useCallback((seconds) => {
    const pad = (value) => String(value).padStart(2, "0");
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  }, []);

  useEffect(() => {
    if (!timerRunning) return undefined;
    const interval = setInterval(() => setTimerElapsedSeconds((current) => current + 1), 1000);
    return () => clearInterval(interval);
  }, [timerRunning]);

  const handleStartWorking = useCallback((taskName = "") => {
    if (taskName) setTimerTaskName(taskName);
    setTimerStartAt(Date.now());
    setTimerRunning(true);
    setTimerElapsedSeconds(0);
    setBanner({ kind: "success", text: "Timer started." });
  }, []);

  const handleStopWorking = useCallback(async () => {
    if (!timerRunning) return;
    setTimerRunning(false);
    setTimerStartAt(null);
    const addedHours = Math.round((timerElapsedSeconds / 3600) * 10) / 10;
    setReportedHoursOverride((current) => {
      const next = current + addedHours;
      try {
        if (user?.id) {
          localStorage.setItem(`reportedHoursOverride_${user.id}`, String(next));
        }
      } catch (err) {
        console.error("Failed to persist reported hours override", err);
      }
      return next;
    });
    setTimerElapsedSeconds(0);
    setTimerTaskName("");

    try {
      const refreshedSummary = await fetchUserHoursSummary(dateKeys, user?.id ?? "");
      setSummary(refreshedSummary);
      setBanner({ kind: "success", text: "Timer stopped and backend confirmed." });
    } catch (err) {
      setBanner({ kind: "warning", text: "Timer stopped, but backend confirmation failed." });
    }
  }, [timerElapsedSeconds, timerRunning, dateKeys, user?.id]);

  const timerButtonText = timerRunning ? "Stop timer" : "Start working";

  const timerStatusText = timerRunning
    ? `⏱ Tracking ${timerTaskName || "work"}`
    : "⏱ Ready to track your time";

  const pendingHours = pendingClaim?.dateKey === activeDate && pendingClaim?.mode !== "adjust" ? pendingClaim.hours : 0;
  const overBudget = pendingClaim?.mode !== "adjust" && pendingClaim != null && pendingHours > pendingClaim.maxHours;
  const isAdjustingToZero = pendingClaim?.mode === "adjust" && pendingClaim.hours === 0;
  const reservedBlocks = useMemo(() => {
    if (!user?.id) return [];
    return dateKeys.flatMap((dateKey) =>
      (weekData[dateKey]?.blocks ?? [])
        .filter((block) => block.myHours > 0)
        .map((block) => ({ ...block, dateKey }))
    );
  }, [dateKeys, weekData, user?.id]);

  const pendingBlock = useMemo(() => {
    if (!pendingClaim) return null;
    return weekData[pendingClaim.dateKey]?.blocks.find((block) => block.id === pendingClaim.blockId) ?? null;
  }, [pendingClaim, weekData]);

  const handleSelectBlock = useCallback(
    async (dateKey, block) => {
      if (isAdmin) {
        setAdminAdjustTarget({
          dateKey,
          blockId: block.id,
          currentHours: block.totalHours,
          reservedHours: block.reservedHours ?? 0,
          targetHours: block.totalHours,
          shiftName: block.shiftName ?? block.workType ?? "Shift",
          startTime: block.startTime ?? "08:00",
          endTime: block.endTime ?? "17:00",
          workType: block.workType,
          maxHoursPerUser: block.maxHoursPerUser ?? 8,
        });
        setActiveDate(dateKey);
        return;
      }
      setBanner(null);
      setActiveDate(dateKey);
      // Fetch fresh rather than trust cached committedHoursByWorkType, which
      // may not yet reflect `dateKey` or `block.workType` if this is the
      // first click after navigating to a new date/project.
      const committedForProject = await fetchUserHoursForDay(dateKey, user?.id ?? "", block.workType);
      const existingHours = block.myHours ?? 0;
      if (existingHours > 0) {
        const blockMaxHours = block.maxHoursPerUser ?? MAX_HOURS_PER_DAY;
        const availableForThisBooking = Math.max(existingHours, (block.remainingHours ?? 0) + existingHours);
        const dailyAllowance = Math.max(existingHours, blockMaxHours - Math.max(0, committedForProject - existingHours));
        const maxHours = Math.min(availableForThisBooking, dailyAllowance);
        setPendingClaim({
          dateKey,
          blockId: block.id,
          hours: existingHours,
          maxHours,
          existingHours,
          mode: "adjust",
          bookingId: block.bookings?.find((booking) => booking.isMine)?.id ?? null,
          workType: block.workType,
        });
        return;
      }
      if (block.isFull) return;
      const blockMaxHours = block.maxHoursPerUser ?? MAX_HOURS_PER_DAY;
      const maxHours = Math.min(block.remainingHours, blockMaxHours - committedForProject);
      if (maxHours <= 0) {
        setBanner({ kind: "error", text: `You're capped at ${blockMaxHours}h/day for ${block.workType}.` });
        return;
      }
      setPendingClaim({
        dateKey,
        blockId: block.id,
        hours: Math.min(1, maxHours),
        maxHours,
        existingHours,
        mode: "reserve",
        workType: block.workType,
        maxHoursPerUser: block.maxHoursPerUser ?? MAX_HOURS_PER_DAY,
      });
    },
    [isAdmin, user?.id]
  );

  const handlePendingHoursChange = useCallback((hours) => {
    setPendingClaim((current) => {
      if (!current) return current;
      if (current.mode === "adjust") {
        setCancelConfirmOpen(hours === 0);
      }
      return { ...current, hours };
    });
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!pendingClaim) return;
    if (pendingClaim.mode === "adjust" && pendingClaim.hours === 0) {
      setCancelConfirmOpen(true);
      return;
    }
    setSubmitting(true);
    setBanner(null);
    try {
      const maxHoursForReservation = pendingClaim.maxHoursPerUser ?? MAX_HOURS_PER_DAY;
      const res =
        pendingClaim.mode === "adjust"
          ? await updateBookingHours(pendingClaim.bookingId, pendingClaim.hours, user?.id ?? "", maxHoursForReservation)
          : await reserveHours(
              pendingClaim.dateKey,
              pendingClaim.blockId,
              pendingClaim.hours,
              user?.id ?? "",
              maxHoursForReservation
            );
      setSubmitting(false);
      if (!res.ok) {
        setBanner({ kind: "error", text: res.error });
        return;
      }
    } catch (err) {
      setSubmitting(false);
      setBanner({ kind: "error", text: "Backend unreachable — cleared local state." });
      setDateKeys([]);
      setWeekData({});
      setSummary({ reportedHours: 0, reservedHours: 0 });
      setCommittedHoursByWorkType({});
      clearCustomWorkTypes();
      return;
    }
    setBanner({
      kind: "success",
      text:
        pendingClaim.mode === "adjust"
          ? `Updated reservation to ${pendingClaim.hours}h on ${formatDateHeading(pendingClaim.dateKey)}.`
          : `Reserved ${pendingClaim.hours}h on ${formatDateHeading(pendingClaim.dateKey)}.`,
    });
    setPendingClaim(null);
    loadWeek(new Date(pendingClaim.dateKey));
  }, [loadWeek, pendingClaim, user?.id]);

  const handleClearPending = useCallback(() => {
    setPendingClaim(null);
    setCancelConfirmOpen(false);
  }, []);

  const handleAdminAdjustHoursChange = useCallback((hours) => {
    setAdminAdjustTarget((current) => (current ? { ...current, targetHours: hours } : current));
  }, []);

  const handleAdminAdjustMaxHoursChange = useCallback((maxHoursPerUser) => {
    setAdminAdjustTarget((current) =>
      current ? { ...current, maxHoursPerUser: maxHoursPerUser } : current
    );
  }, []);

  const handleAdminAdjustConfirm = useCallback(async () => {
    if (!adminAdjustTarget) return;
    setSubmitting(true);
    setBanner(null);
    try {
      const res = await adjustReleasedHours(
        adminAdjustTarget.dateKey,
        adminAdjustTarget.blockId,
        adminAdjustTarget.targetHours,
        adminAdjustTarget.shiftName,
        adminAdjustTarget.startTime,
        adminAdjustTarget.endTime,
        adminAdjustTarget.workType,
        adminAdjustTarget.maxHoursPerUser
      );
      setSubmitting(false);
      if (!res.ok) {
        setBanner({ kind: "error", text: res.error });
        return;
      }
    } catch (err) {
      setSubmitting(false);
      setBanner({ kind: "error", text: "Backend unreachable — cleared local state." });
      setDateKeys([]);
      setWeekData({});
      setSummary({ reportedHours: 0, reservedHours: 0 });
      setCommittedHoursByWorkType({});
      clearCustomWorkTypes();
      return;
    }
    setBanner({ kind: "success", text: `Updated released capacity to ${adminAdjustTarget.targetHours}h.` });
    setAdminAdjustTarget(null);
    loadWeek(new Date(adminAdjustTarget.dateKey));
  }, [adminAdjustTarget, loadWeek]);

  const handleCancelReservation = useCallback(async () => {
    if (!pendingClaim?.bookingId) return;
    setSubmitting(true);
    setCancelConfirmOpen(false);
    try {
      const res = await updateBookingHours(pendingClaim.bookingId, 0, user?.id ?? "");
      setSubmitting(false);
      if (!res.ok) {
        setBanner({ kind: "error", text: res.error });
        return;
      }
    } catch (err) {
      setSubmitting(false);
      setBanner({ kind: "error", text: "Backend unreachable — cleared local state." });
      setDateKeys([]);
      setWeekData({});
      setSummary({ reportedHours: 0, reservedHours: 0 });
      setCommittedHoursByWorkType({});
      clearCustomWorkTypes();
      return;
    }
    setBanner({ kind: "success", text: "Reservation cancelled." });
    setPendingClaim(null);
    loadWeek(new Date(pendingClaim.dateKey));
  }, [loadWeek, pendingClaim, user?.id]);

  // Bug fix (Bug 6): anchorDate was used inside but missing from dep array.
  const handleCancelBooking = useCallback(
    async (bookingId) => {
      setSubmitting(true);
      try {
        const res = await cancelBooking(bookingId, user?.id ?? "");
        setSubmitting(false);
        setBanner(res.ok ? { kind: "success", text: "Booking cancelled." } : { kind: "error", text: res.error });
        if (res.ok) loadWeek(anchorDate);
      } catch (err) {
        setSubmitting(false);
        setBanner({ kind: "error", text: "Backend unreachable — cleared local state." });
        setDateKeys([]);
        setWeekData({});
        setSummary({ reportedHours: 0, reservedHours: 0 });
        setCommittedHoursByWorkType({});
        clearCustomWorkTypes();
        return;
      }
    },
    [loadWeek, user?.id, anchorDate]
  );

  // Bug fix (Bug 7): anchorDate was used inside but missing from dep array.
  const handleRevokeBlock = useCallback(
    async (dateKey, blockId) => {
      try {
        const res = await revokeBlock(dateKey, blockId);
        setBanner(res.ok ? { kind: "success", text: "Released block removed." } : { kind: "error", text: res.error });
        if (res.ok) loadWeek(anchorDate);
      } catch (err) {
        setBanner({ kind: "error", text: "Backend unreachable — cleared local state." });
        setDateKeys([]);
        setWeekData({});
        setSummary({ reportedHours: 0, reservedHours: 0 });
        setCommittedHoursByWorkType({});
        clearCustomWorkTypes();
        return;
      }
    },
    [loadWeek, anchorDate]
  );

  const handleDateChange = useCallback((dateKey) => {
    const [year, month, day] = dateKey.split("-").map(Number);
    setActiveDate(dateKey);
    setAnchorDate(new Date(year, month - 1, day));
    setMonthCursor({ year, month: month - 1 });
  }, []);

  const handleRelease = useCallback(
    async ({ dateKey, totalHours, shiftName, startTime, endTime, workType, maxHoursPerUser }) => {
      const [year, month, day] = dateKey.split("-").map(Number);
      setSubmitting(true);
      setBanner(null);
      try {
        const releaseResult = await releaseHours(
          dateKey,
          totalHours,
          totalHours,
          0,
          shiftName,
          startTime,
          endTime,
          workType,
          user?.id ?? "",
          maxHoursPerUser
        );
        setSubmitting(false);
        if (!releaseResult.ok) {
          setBanner({ kind: "error", text: releaseResult.error || "Failed to release capacity." });
          return;
        }
      } catch (err) {
        setSubmitting(false);
        setBanner({ kind: "error", text: "Backend unreachable — cleared local state." });
        setDateKeys([]);
        setWeekData({});
        setSummary({ reportedHours: 0, reservedHours: 0 });
        setCommittedHoursByWorkType({});
        clearCustomWorkTypes();
        return;
      }
      setActiveDate(dateKey);
      setAnchorDate(new Date(year, month - 1, day));
      setMonthCursor({ year, month: month - 1 });
      setAdminProjectFilter(workType);
      await loadWeek(new Date(year, month - 1, day), true);
      setBanner({
        kind: "success",
        text: `Released ${totalHours}h of ${workType} capacity on ${formatDateHeading(dateKey)}.`,
      });
    },
    [loadWeek, user?.id, setAdminProjectFilter]
  );

  const handleToggleLayer = useCallback((layerKey) => {
    setVisibleLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layerKey)) next.delete(layerKey);
      else next.add(layerKey);
      return next;
    });
  }, []);

  const handlePrevMonth = useCallback(() => {
    setMonthCursor((c) => (c.month === 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: c.month - 1 }));
  }, []);

  const handleNextMonth = useCallback(() => {
    setMonthCursor((c) => (c.month === 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: c.month + 1 }));
  }, []);

  const handleSelectDate = useCallback((date) => {
    setAnchorDate(date);
    setActiveDate(toDateKey(date));
    setMonthCursor({ year: date.getFullYear(), month: date.getMonth() });
  }, []);

  const handlePrevWeek = useCallback(() => {
    setAnchorDate((d) => {
      const next = new Date(d);
      next.setDate(next.getDate() - 7);
      setMonthCursor({ year: next.getFullYear(), month: next.getMonth() });
      return next;
    });
  }, []);

  const handleNextWeek = useCallback(() => {
    setAnchorDate((d) => {
      const next = new Date(d);
      next.setDate(next.getDate() + 7);
      setMonthCursor({ year: next.getFullYear(), month: next.getMonth() });
      return next;
    });
  }, []);

  const handleJumpToToday = useCallback(() => {
    setAnchorDate(todayDate);
    setActiveDate(todayKey);
    setMonthCursor({ year: todayDate.getFullYear(), month: todayDate.getMonth() });
  }, []);

  const midWeekDate = dateKeys.length === 7 ? new Date(`${dateKeys[3]}T00:00:00`) : null;
  const weekHeading = midWeekDate ? formatMonthHeading(midWeekDate.getFullYear(), midWeekDate.getMonth()) : "";
  const rangeLabel = dateKeys.length === 7 ? `${formatDateHeading(dateKeys[0])} - ${formatDateHeading(dateKeys[6])}` : "";

  // Max hours ceiling for the admin adjust slider — generous enough to let
  // admins increase a block, not just decrease it. We allow up to 3× the
  // current total or 200h, whichever is lower.
  const adminAdjustMax = adminAdjustTarget
    ? Math.min(200, Math.max(adminAdjustTarget.currentHours * 3, adminAdjustTarget.currentHours + 50))
    : 200;

  // For the HourGauge: sum committed hours across all projects for the active date.
  const totalCommittedForActiveDate = Object.values(committedHoursByWorkType).reduce((a, b) => a + b, 0);

  return (
    <div className="board-page">
      <Header user={user} onLogout={logout} onShowReservedBlocks={() => setShowReservedBlocks(true)} timerRunning={timerRunning} />

      <main className="board-main board-main--week">
        {showReservedBlocks && (
          <div className="reserved-blocks-overlay" role="dialog" aria-modal="true" onClick={() => setShowReservedBlocks(false)}>
            <div className="reserved-blocks-panel" onClick={(event) => event.stopPropagation()}>
              <div className="reserved-blocks-modal-grid">
                <div className="reserved-timer-card">
                  <div className="reserved-timer-clock">{formatSeconds(timerElapsedSeconds)}</div>
                  <div className="reserved-timer-status">{timerStatusText}</div>
                  {timerRunning && (
                    <div className="reserved-timer-action reserved-timer-action--stop">
                      <button className="btn btn--ghost reserved-timer-button" onClick={handleStopWorking}>
                        Stop timer
                      </button>
                    </div>
                  )}
                  <div className="reserved-timer-summary">Total reported hours: {effectiveReportedHours.toFixed(1)}h</div>
                  <div className="reserved-timer-footer">
                    <div className="reserved-timer-user">
                      {user?.avatarUrl ? (
                        <img src={user.avatarUrl} alt="User avatar" className="reserved-timer-avatar reserved-timer-avatar--img" />
                      ) : (
                        <span className="reserved-timer-avatar">{userInitials}</span>
                      )}
                      <div>
                        <div className="reserved-timer-name">{user?.name ?? "Work user"}</div>
                        <div className="reserved-timer-email">{user?.email ?? "No email"}</div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="reserved-blocks-right">
                  <div className="reserved-blocks-titlebar">
                    <span>Your reserved block(s)</span>
                    <button
                      className="btn btn--ghost reserved-blocks-refresh"
                      disabled={isRefreshingReserved}
                      onClick={handleRefreshReservedBlocks}
                    >
                      {isRefreshingReserved ? (
                        <>
                          <span className="reserved-button-spinner" aria-hidden="true" />
                          Refreshing...
                        </>
                      ) : (
                        "Refresh"
                      )}
                    </button>
                  </div>
                  <div className="reserved-blocks-list">
                    {reservedBlocks.length === 0 ? (
                      <div className="reserved-blocks-empty">You have no reserved blocks this week.</div>
                    ) : (
                      reservedBlocks.map((block) => (
                        <div key={block.id} className="reserved-block-card reserved-block-card--task">
                        <div className="reserved-block-card-title-row">
                          <div>
                            <div className="reserved-block-card-label">{block.workType || "Task"}</div>
                            <div className="reserved-block-card-title">{block.shiftName || block.workType || "Shift"}</div>
                          </div>
                          <div className="reserved-block-card-meta">
                            <span className="reserved-block-card-duration">{block.myHours}h</span>
                            <button
                              className={
                                `btn btn--ghost reserved-block-card-start ${
                                  !timerRunning && isShiftExpired(block.dateKey, block.endTime)
                                    ? "btn--disabled"
                                    : ""
                                }`
                              }
                              disabled={!timerRunning && isShiftExpired(block.dateKey, block.endTime)}
                              onClick={() => {
                                const isCurrentTask =
                                  timerRunning &&
                                  timerTaskName &&
                                  [block.workType, block.shiftName]
                                    .filter(Boolean)
                                    .some((task) => task.toLowerCase() === timerTaskName.toLowerCase());
                                if (isCurrentTask) {
                                  handleStopWorking();
                                  return;
                                }

                                if (isShiftExpired(block.dateKey, block.endTime)) {
                                  setBanner({
                                    kind: "error",
                                    text: "This block has expired.",
                                  });
                                  return;
                                }

                                if (!isNowInShiftWindow(block.dateKey, block.startTime, block.endTime)) {
                                  setBanner({
                                    kind: "error",
                                    text: `Cannot start timer outside the permitted shift window (${block.startTime}–${block.endTime}).`,
                                  });
                                  return;
                                }

                                handleStartWorking(block.workType || block.shiftName || "Task");
                              }}
                              title={
                                !timerRunning && isShiftExpired(block.dateKey, block.endTime)
                                  ? "This block has expired"
                                  : undefined
                              }
                            >
                              {timerRunning && timerTaskName && [block.workType, block.shiftName]
                                .filter(Boolean)
                                .some((task) => task.toLowerCase() === timerTaskName.toLowerCase())
                                ? "Stop timer"
                                : isShiftExpired(block.dateKey, block.endTime)
                                ? "Expired"
                                : "Start timer"}
                            </button>
                          </div>
                        </div>
                        <div className="reserved-block-details">
                          between {block.dateKey} {block.startTime} to {block.endTime}
                        </div>
                      </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        <aside className="board-rail">
          <MiniMonth
            year={monthCursor.year}
            month={monthCursor.month}
            onPrevMonth={handlePrevMonth}
            onNextMonth={handleNextMonth}
            selectedDate={anchorDate}
            onSelectDate={handleSelectDate}
            todayKey={todayKey}
          />
          <CalendarLayers visibleLayers={visibleLayers} onToggle={handleToggleLayer} />
          <TimeInsights
            reportedHours={effectiveReportedHours}
            reservedHours={summary.reservedHours}
            releasedHours={dateKeys.reduce((sum, key) => sum + (weekData[key]?.summary.releasedHours ?? 0), 0)}
            rangeLabel={rangeLabel}
            daysInRange={7}
            projectCount={Math.max(1, grantedWorkTypes?.length ?? 1)}
            isAdmin={isAdmin}
            todayByProject={(grantedWorkTypes ?? []).map((workType) => ({
              workType,
              hours: committedHoursForWorkType(workType),
            }))}
          />
        </aside>

        <section className="board-week-area">
          <div className="week-nav">
            <div className="week-nav-controls">
              <button className="week-nav-arrow" onClick={handlePrevWeek} aria-label="Previous week">
                &lsaquo;
              </button>
              <button className="week-nav-arrow" onClick={handleNextWeek} aria-label="Next week">
                &rsaquo;
              </button>
              <span className="week-nav-heading">{weekHeading}</span>
            </div>
            <div className="week-nav-meta">
              <button className="btn btn--ghost week-nav-today" onClick={handleJumpToToday}>
                Today
              </button>
              <span className="week-nav-tz">Africa/Nairobi</span>
            </div>
          </div>

          {isAdmin && (
            <AdminReleasePanel
              onRelease={handleRelease}
              onSelectBlock={handleSelectBlock}
              onProjectFilterChange={handleAdminProjectFilterChange}
              disabled={loading || submitting}
              selectedDate={activeDate}
              onDateChange={handleDateChange}
              customWorkTypes={customWorkTypes}
              onAddWorkType={handleAddWorkType}
              highlightedProject={highlightedProject}
              dateBlocks={weekData[activeDate]?.blocks ?? []}
            />
          )}
          
          {isAdmin && (
            <AdminProjectsAndUsers
              adminId={user?.email || "Admin"}
              projects={customWorkTypes}
              onAddProject={handleAddWorkType}
              userAccess={workTypeAccess}
              onGrantAccess={grantWorkTypeAccess}
              onRevokeAccess={revokeWorkTypeAccess}
            />
          )}

          {isAdmin && (
            <AdminInsights
              dateKeys={dateKeys}
              weekData={weekData}
              customWorkTypes={customWorkTypes}
              projectFilter={adminProjectFilter}
            />
          )}
          
          {banner && <div className={`banner banner--${banner.kind}`}>{banner.text}</div>}

          {/* ── Admin: adjust released block hours (increase OR decrease) ── */}
          {adminAdjustTarget && (
            <div className="claim-modal-overlay" role="dialog" aria-modal="true">
              <div className="claim-modal">
                <div className="claim-modal-title">Adjust released hours</div>
                <p className="claim-modal-sub">
                  Increase or decrease the released capacity for this block. You cannot reduce below the hours
                  already reserved ({adminAdjustTarget.reservedHours}h).
                </p>
                <div className="claim-modal-times">
                  <span>Current: {adminAdjustTarget.currentHours}h released</span>
                  <span>Reserved: {adminAdjustTarget.reservedHours}h</span>
                </div>
                <label className="claim-modal-slider">
                  <span>{adminAdjustTarget.targetHours}h</span>
                  <input
                    type="range"
                    min={Math.max(1, adminAdjustTarget.reservedHours)}
                    max={adminAdjustMax}
                    step="1"
                    value={adminAdjustTarget.targetHours}
                    onChange={(event) => handleAdminAdjustHoursChange(Number(event.target.value))}
                  />
                  <small>
                    Min {Math.max(1, adminAdjustTarget.reservedHours)}h (already reserved) · max {adminAdjustMax}h
                  </small>
                </label>
                <label className="admin-field" style={{ marginTop: 12 }}>
                  <span>Max/user</span>
                  <input
                    type="number"
                    min="1"
                    max="24"
                    value={adminAdjustTarget.maxHoursPerUser}
                    onChange={(event) => handleAdminAdjustMaxHoursChange(Number(event.target.value))}
                  />
                </label>
                <div className="claim-modal-actions">
                  <button className="btn btn--ghost" onClick={() => setAdminAdjustTarget(null)}>
                    Cancel
                  </button>
                  <button className="btn btn--teal" disabled={submitting} onClick={handleAdminAdjustConfirm}>
                    {submitting ? "Updating..." : "Save"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── User: claim or adjust a block ── */}
          {!isAdmin && pendingBlock && (
            <div className="claim-modal-overlay" role="dialog" aria-modal="true">
              {cancelConfirmOpen ? (
                <div className="claim-modal">
                  <div className="claim-modal-title">Cancel reservation?</div>
                  <p className="claim-modal-sub">This will remove your current reservation for this block.</p>
                  <div className="claim-modal-actions">
                    <button className="btn btn--ghost" onClick={() => setCancelConfirmOpen(false)}>
                      Keep reservation
                    </button>
                    <button className="btn btn--teal" disabled={submitting} onClick={handleCancelReservation}>
                      {submitting ? "Cancelling..." : "Cancel reservation"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="claim-modal">
                  <div className="claim-modal-title">
                    {pendingClaim.mode === "adjust" ? "Adjust your reservation" : "Claim this block"}
                  </div>

                  {/* Project name badge */}
                  {pendingClaim.workType && (
                    <div className="claim-modal-project-badge">
                      <span className="claim-modal-project-dot" />
                      {pendingClaim.workType}
                    </div>
                  )}

                  <p className="claim-modal-sub">
                    {pendingClaim.mode === "adjust"
                      ? "Adjust your current reservation for this released block."
                      : "Choose how many hours to reserve from this released block."}
                  </p>
                  <div className="claim-modal-times">
                    <span>Start: {pendingBlock?.startTime ?? "08:00"}</span>
                    <span>End: {pendingBlock?.endTime ?? "16:00"}</span>
                  </div>
                  <label className="claim-modal-slider">
                    <span>{pendingClaim.hours}h</span>
                    <input
                      type="range"
                      min="0"
                      max={pendingClaim.maxHours}
                      step="1"
                      value={pendingClaim.hours}
                      onChange={(event) => handlePendingHoursChange(Number(event.target.value))}
                    />
                    <small>
                      {pendingClaim.mode === "adjust"
                        ? `Choose between 0h and ${pendingClaim.maxHours}h; setting it to 0 cancels the reservation.`
                        : `Up to ${pendingClaim.maxHours}h available`}
                    </small>
                  </label>
                  <div className="claim-modal-actions">
                    <button className="btn btn--ghost" onClick={handleClearPending}>
                      Cancel
                    </button>
                    <button className="btn btn--teal" disabled={overBudget || submitting} onClick={handleConfirm}>
                      {submitting
                        ? pendingClaim.mode === "adjust"
                          ? "Updating..."
                          : "Reserving..."
                        : pendingClaim.mode === "adjust"
                          ? isAdjustingToZero
                            ? "Cancel reservation"
                            : "Save"
                          : "Confirm"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="board-week-grid-wrap">
            {loading && Object.keys(weekData).length === 0 ? (
              <div className="ledger-loading">Loading the week...</div>
            ) : (
              <WeekGrid
                dateKeys={dateKeys}
                weekData={weekData}
                pendingClaim={pendingClaim}
                projectFilter={adminProjectFilter}
                onSelectBlock={handleSelectBlock}
                onCancelBooking={handleCancelBooking}
                visibleLayers={visibleLayers}
                todayKey={todayKey}
                isAdmin={isAdmin}
                onRevokeBlock={handleRevokeBlock}
                disabled={submitting}
              />
            )}
          </div>
        </section>

      </main>
    </div>
  );
}
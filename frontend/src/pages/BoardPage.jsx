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
  fetchActiveTimer,
  startTimer as apiStartTimer,
  stopTimer as apiStopTimer,
} from "../data/backendApi";
import { formatDateHeading, formatMonthHeading, MAX_HOURS_PER_DAY, toDateKey } from "../data/schedule";
import Header from "../components/Header";
import MiniMonth from "../components/MiniMonth";
import CalendarLayers from "../components/CalendarLayers";
import TimeInsights from "../components/TimeInsights";
import HourGauge from "../components/HourGauge";
import WeekGrid from "../components/WeekGrid";
import AdminReleasePanel from "../components/AdminReleasePanel";
import AdminProjectsAndUsers from "../components/AdminProjectsAndUsers";
import AdminInsights from "../components/AdminInsights";

const todayDate = new Date();
const todayKey = toDateKey(todayDate);

// If a timer was left running across a gap longer than this, we don't
// trust the elapsed time as real tracked work — auto-stop it and bank a
// capped amount instead of silently reporting days of "elapsed" time.
const MAX_PLAUSIBLE_TIMER_HOURS = 12;

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
  const [timerBookingId, setTimerBookingId] = useState(null);
  const [timerBlockId, setTimerBlockId] = useState(null);
  const [timerDateKey, setTimerDateKey] = useState(null);
  // True while the browser reports no network connection. While offline,
  // the running timer's display is frozen (no further hours are tracked)
  // rather than silently continuing to count against a server it can't
  // reach; see the online/offline effect further down.
  const [isOffline, setIsOffline] = useState(() => (typeof navigator !== "undefined" ? !navigator.onLine : false));
  // Hours banked from previously-stopped timers, on top of completed-booking
  // hours. Lives entirely on the backend (Store.reportedOverride, keyed by
  // userId) — fetched here, never written to localStorage.
  const [bankedHours, setBankedHours] = useState(0);
  // { [bookingId]: hoursAlreadyWorkedAndBanked } — per-booking breakdown of
  // the above, so the reserved-blocks panel can show "X.Xh left" on a block
  // someone already partially worked, and offer "Resume" instead of
  // "Start timer".
  const [bookingBanked, setBookingBanked] = useState({});
  const [isRefreshingReserved, setIsRefreshingReserved] = useState(false);

  // Popup/toast notifications — used for events the user needs to notice
  // even if a modal (e.g. the reserved-blocks overlay) is open on top of
  // the page, which the inline `banner` renders underneath and behind.
  const [toasts, setToasts] = useState([]);
  const nextToastId = useRef(1);
  const pushToast = useCallback((kind, text, durationMs = 7000) => {
    const id = nextToastId.current++;
    setToasts((current) => [...current, { id, kind, text }]);
    if (durationMs) {
      setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, durationMs);
    }
    return id;
  }, []);
  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);


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

  const effectiveReportedHours = summary.reportedHours + bankedHours;

  // Pull the active timer (if any) from the backend whenever the user
  // changes — this is what lets a second browser/private window, or a page
  // refresh, see the SAME running timer instead of each tab inventing its
  // own local state. No localStorage involved.
  useEffect(() => {
    if (!user?.id) {
      setTimerRunning(false);
      setTimerStartAt(null);
      setTimerTaskName("");
      setTimerBookingId(null);
      setTimerBlockId(null);
      setTimerDateKey(null);
      setTimerElapsedSeconds(0);
      setBankedHours(0);
      setBookingBanked({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchActiveTimer(user.id);
        if (cancelled) return;
        setBankedHours(res?.bankedHours ?? 0);
        setBookingBanked(res?.bookingBanked ?? {});
        if (res?.autoStopped) {
          setBanner({
            kind: "warning",
            text: `A timer was left running for over ${MAX_PLAUSIBLE_TIMER_HOURS}h and has been auto-stopped on the server; ${res.autoStoppedFor}h was banked. Please verify your reported hours.`,
          });
        }
        if (res?.timer) {
          const restoredSeconds = Math.max(0, Math.round((Date.now() - res.timer.startAt) / 1000));
          setTimerRunning(true);
          setTimerStartAt(res.timer.startAt);
          setTimerTaskName(res.timer.taskName ?? "");
          setTimerBookingId(res.timer.bookingId || null);
          setTimerBlockId(res.timer.blockId || null);
          setTimerDateKey(res.timer.dateKey || null);
          setTimerElapsedSeconds(restoredSeconds);
        } else {
          setTimerRunning(false);
          setTimerStartAt(null);
          setTimerTaskName("");
          setTimerBookingId(null);
          setTimerBlockId(null);
          setTimerDateKey(null);
          setTimerElapsedSeconds(0);
        }
      } catch (err) {
        console.error("Failed to fetch active timer from backend", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!showReservedBlocks) return;
    // Avoid a forced full-week reload every time the modal is opened — only
    // refetch if we don't actually have data yet for the current week.
    if (dateKeys.length === 0 || Object.keys(weekData).length === 0) {
      loadWeek(anchorDate, true);
    }
  }, [showReservedBlocks, anchorDate, loadWeek, dateKeys.length, weekData]);

  // Computes the real start/end Date objects for a shift window, handling
  // overnight shifts (e.g. "16:00" -> "00:00" or "22:00" -> "02:00") by
  // rolling the end time to the next calendar day whenever endTime is not
  // strictly after startTime. Mirrors the overnight-rollover handling in
  // schedule.js's slotEndDateTime, which this logic previously lacked.
  const getShiftWindow = useCallback((dateKey, startTime, endTime) => {
    if (!dateKey || !startTime || !endTime) return null;
    const [year, month, day] = dateKey.split("-").map(Number);
    const [startHour, startMinute] = startTime.split(":").map(Number);
    const [endHour, endMinute] = endTime.split(":").map(Number);
    const start = new Date(year, month - 1, day, startHour, startMinute, 0, 0);
    const startMinutesOfDay = startHour * 60 + startMinute;
    const endMinutesOfDay = endHour * 60 + endMinute;
    const dayOffset = endMinutesOfDay > startMinutesOfDay ? 0 : 1;
    const end = new Date(year, month - 1, day + dayOffset, endHour, endMinute, 0, 0);
    return { start, end };
  }, []);

  const isNowInShiftWindow = useCallback((dateKey, startTime, endTime) => {
    const window = getShiftWindow(dateKey, startTime, endTime);
    if (!window) return false;
    const now = new Date();
    return now >= window.start && now <= window.end;
  }, [getShiftWindow]);

  const isShiftExpired = useCallback((dateKey, endTime, startTime) => {
    const window = getShiftWindow(dateKey, startTime, endTime);
    if (!window) return false;
    return new Date() > window.end;
  }, [getShiftWindow]);

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
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return days > 0
      ? `${days}d ${pad(hours)}:${pad(minutes)}:${pad(secs)}`
      : `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  }, []);

  const handleStartWorking = useCallback(async (taskName = "", booking = {}) => {
    if (!user?.id) return;
    setBanner(null);
    try {
      const res = await apiStartTimer(
        user.id,
        taskName,
        booking.bookingId ?? "",
        booking.blockId ?? "",
        booking.dateKey ?? ""
      );
      if (!res?.ok || !res?.timer) {
        setBanner({ kind: "error", text: "Could not start the timer — backend rejected the request." });
        return;
      }
      setTimerTaskName(res.timer.taskName ?? taskName ?? "");
      setTimerBookingId(res.timer.bookingId || null);
      setTimerBlockId(res.timer.blockId || null);
      setTimerDateKey(res.timer.dateKey || null);
      setTimerStartAt(res.timer.startAt);
      setTimerRunning(true);
      setTimerElapsedSeconds(0);
      setBanner({ kind: "success", text: "Timer started." });
    } catch (err) {
      setBanner({ kind: "error", text: "Backend unreachable — could not start timer." });
    }
  }, [user?.id]);

  const handleStopWorking = useCallback(async () => {
    if (!timerRunning || !user?.id) return;
    try {
      const res = await apiStopTimer(user.id);
      setTimerRunning(false);
      setTimerStartAt(null);
      setTimerElapsedSeconds(0);
      setTimerTaskName("");
      setTimerBookingId(null);
      setTimerBlockId(null);
      setTimerDateKey(null);
      if (res?.ok) {
        setBankedHours(res.bankedHours ?? 0);
        setBookingBanked(res.bookingBanked ?? {});
      }
      const refreshedSummary = await fetchUserHoursSummary(dateKeys, user.id);
      setSummary(refreshedSummary);
      setBanner({ kind: "success", text: "Timer stopped and backend confirmed." });
    } catch (err) {
      setBanner({ kind: "warning", text: "Timer stopped locally, but backend confirmation failed." });
    }
  }, [timerRunning, dateKeys, user?.id]);

  // Finalize a timer that was paused by a network outage: tell the backend
  // to bank only the elapsed time captured at the moment the connection
  // dropped (snapshotSeconds), not however much real time has actually
  // passed since — the offline gap itself must NOT count as worked time.
  const handleOfflineAutoStop = useCallback(async (snapshotSeconds) => {
    if (!user?.id) return;
    try {
      const res = await apiStopTimer(user.id, snapshotSeconds);
      setTimerRunning(false);
      setTimerStartAt(null);
      setTimerElapsedSeconds(0);
      setTimerTaskName("");
      setTimerBookingId(null);
      setTimerBlockId(null);
      setTimerDateKey(null);
      if (res?.ok) {
        setBankedHours(res.bankedHours ?? 0);
        setBookingBanked(res.bookingBanked ?? {});
      }
      const refreshedSummary = await fetchUserHoursSummary(dateKeys, user.id);
      setSummary(refreshedSummary);
      pushToast(
        "success",
        `Back online — ${formatSeconds(Math.round(snapshotSeconds))} reported (tracked before the connection dropped). Start working again to resume.`
      );
    } catch (err) {
      pushToast("warning", "Back online, but couldn't confirm the timer stop with the server — please check your reported hours.");
    }
  }, [user?.id, dateKeys, pushToast, formatSeconds]);

  // Track the live elapsed seconds in a ref too, so the offline/online
  // listeners (which run outside the render cycle) can read the latest
  // value synchronously without depending on (and re-binding to) state.
  const timerElapsedSecondsRef = useRef(0);
  useEffect(() => {
    timerElapsedSecondsRef.current = timerElapsedSeconds;
  }, [timerElapsedSeconds]);

  const offlineSnapshotRef = useRef(null);
  const offlineToastIdRef = useRef(null);

  useEffect(() => {
    const handleOffline = () => {
      setIsOffline(true);
      if (timerRunning) {
        offlineSnapshotRef.current = timerElapsedSecondsRef.current;
        offlineToastIdRef.current = pushToast(
          "warning",
          `You're offline — the timer is paused at ${formatSeconds(timerElapsedSecondsRef.current)}. It will stop and report this time once you're back online.`,
          0
        );
      } else {
        offlineToastIdRef.current = pushToast("warning", "You're offline. Some actions won't work until your connection returns.", 0);
      }
    };
    const handleOnline = () => {
      setIsOffline(false);
      if (offlineToastIdRef.current != null) {
        dismissToast(offlineToastIdRef.current);
        offlineToastIdRef.current = null;
      }
      const snapshot = offlineSnapshotRef.current;
      offlineSnapshotRef.current = null;
      if (snapshot != null) {
        handleOfflineAutoStop(snapshot);
      } else {
        pushToast("success", "Back online.");
      }
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [timerRunning, handleOfflineAutoStop, pushToast, dismissToast, formatSeconds]);

  useEffect(() => {
    // While offline, freeze the displayed timer instead of letting it keep
    // counting locally with no way to actually report to the server.
    if (!timerRunning || isOffline) return undefined;
    const interval = setInterval(() => {
      setTimerElapsedSeconds((current) => {
        const next = current + 1;
        if (next >= MAX_PLAUSIBLE_TIMER_HOURS * 3600) {
          // The backend enforces the real cap (it auto-stops + banks on the
          // next GET /api/timer or POST /api/timer/stop) — calling stop here
          // just makes sure that happens promptly rather than waiting for
          // the user to next interact with the page.
          setTimeout(() => handleStopWorking(), 0);
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [timerRunning, isOffline, handleStopWorking]);

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

  // Step 7: the block currently being tracked, plus how much of its claimed
  // hours have been consumed so far — surfaced as a progress bar on the big
  // timer card itself, filling the space that used to sit empty below the
  // clock once the old footer moved up into the header.
  const activeTrackedBlock = useMemo(() => {
    if (!timerRunning || timerBookingId == null) return null;
    return reservedBlocks.find((block) => block.bookings?.some((booking) => booking.isMine && booking.id === timerBookingId)) ?? null;
  }, [reservedBlocks, timerRunning, timerBookingId]);

  const activeTrackedProgressPct = useMemo(() => {
    if (!activeTrackedBlock || activeTrackedBlock.myHours <= 0) return 0;
    const banked = timerBookingId != null ? (bookingBanked[timerBookingId] ?? 0) : 0;
    const liveWorked = banked + timerElapsedSeconds / 3600;
    return Math.min(100, Math.max(0, (liveWorked / activeTrackedBlock.myHours) * 100));
  }, [activeTrackedBlock, bookingBanked, timerBookingId, timerElapsedSeconds]);

  const autoStopInFlightRef = useRef(false);

  // Auto-stop the running timer when either:
  //   (a) the block's own shift window (startTime–endTime) has passed, or
  //   (b) the user has fully consumed the hours they reserved on this block
  //       (myHours) — this is the case from the bug report: a 1h reservation
  //       whose elapsed time reached 1h while the shift window itself
  //       (e.g. 08:00–17:00) was nowhere near over.
  // Either way the timer shouldn't keep ticking silently — stop it, bank
  // whatever was worked, and tell the user why via a toast (banners render
  // inline in the page and are hidden behind the reserved-blocks modal).
  useEffect(() => {
    if (!timerRunning) {
      autoStopInFlightRef.current = false;
      return undefined;
    }
    if (!activeTrackedBlock || autoStopInFlightRef.current) return undefined;

    const shiftExpired = isShiftExpired(activeTrackedBlock.dateKey, activeTrackedBlock.endTime, activeTrackedBlock.startTime);
    const banked = timerBookingId != null ? (bookingBanked[timerBookingId] ?? 0) : 0;
    const liveWorkedHours = banked + timerElapsedSeconds / 3600;
    const hoursExhausted = activeTrackedBlock.myHours > 0 && liveWorkedHours >= activeTrackedBlock.myHours;

    if (!shiftExpired && !hoursExhausted) return undefined;

    autoStopInFlightRef.current = true;
    const label = activeTrackedBlock.shiftName || activeTrackedBlock.workType || "this block";
    const reason = shiftExpired
      ? `the shift window (${activeTrackedBlock.startTime}–${activeTrackedBlock.endTime}) has ended`
      : `you've used all ${activeTrackedBlock.myHours}h reserved on ${label}`;
    handleStopWorking().then(() => {
      pushToast("error", `Reservation expired — ${reason}. Timer stopped automatically and your hours were reported. Start working again to continue.`);
      setBanner({ kind: "error", text: `Reservation expired (${label}) — timer stopped automatically and your hours were reported.` });
    });
  }, [timerRunning, activeTrackedBlock, timerElapsedSeconds, timerBookingId, bookingBanked, isShiftExpired, handleStopWorking, pushToast]);

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
      // If this is the block whose timer is currently running, the backend
      // will reject any change/cancel on it anyway — don't even open the
      // modal, just tell the user up front via a toast.
      if ((block.myHours ?? 0) > 0 && timerRunning && activeTrackedBlock?.id === block.id) {
        pushToast("warning", "Stop the timer before changing or cancelling this reservation.");
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
        const bookingId = block.bookings?.find((booking) => booking.isMine)?.id ?? null;
        // The backend won't let hours drop below what's already been worked
        // on this booking (and won't let it be cancelled at all once any
        // time has been banked). Mirror that here so the slider can't even
        // be dragged into a value the next request would just reject.
        const workedHours = bookingId != null ? (bookingBanked[bookingId] ?? 0) : 0;
        const minHours = workedHours > 0 ? Math.max(1, Math.ceil(workedHours)) : 0;
        setPendingClaim({
          dateKey,
          blockId: block.id,
          hours: existingHours,
          maxHours,
          minHours,
          workedHours,
          existingHours,
          mode: "adjust",
          bookingId,
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
    [isAdmin, user?.id, timerRunning, activeTrackedBlock, pushToast, bookingBanked]
  );

  const handlePendingHoursChange = useCallback((hours) => {
    setPendingClaim((current) => {
      if (!current) return current;
      if (current.mode === "adjust") {
        const floor = current.minHours ?? 0;
        const clamped = Math.max(hours, floor);
        setCancelConfirmOpen(floor === 0 && clamped === 0);
        return { ...current, hours: clamped };
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
      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast--${toast.kind}`}>
              <span className="toast-text">{toast.text}</span>
              <button className="toast-dismiss" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <Header user={user} onLogout={logout} onShowReservedBlocks={() => setShowReservedBlocks(true)} timerRunning={timerRunning} />


      <main className="board-main board-main--week">
        {showReservedBlocks && (
          <div className="reserved-blocks-overlay" role="dialog" aria-modal="true" onClick={() => setShowReservedBlocks(false)}>
            <div className="reserved-blocks-panel" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                className="reserved-blocks-close"
                onClick={() => setShowReservedBlocks(false)}
                aria-label="Close"
                title="Close"
              >
                ✕
              </button>
              <div className="reserved-blocks-modal-grid">
                <div className="reserved-timer-card">
                  <div className="reserved-timer-header">
                    <div className="reserved-timer-user">
                      {user?.avatarUrl ? (
                        <img src={user.avatarUrl} alt="User avatar" className="reserved-timer-avatar reserved-timer-avatar--img" />
                      ) : (
                        <span className="reserved-timer-avatar">{userInitials}</span>
                      )}
                      <div>
                        <div className="reserved-timer-name-row">
                          <span className="reserved-timer-name">{user?.name ?? "Work user"}</span>
                          <span className={`reserved-timer-status-chip ${timerRunning ? "reserved-timer-status-chip--live" : ""}`}>
                            {timerStatusText}
                          </span>
                        </div>
                        <div className="reserved-timer-email">{user?.email ?? "No email"}</div>
                      </div>
                    </div>
                    <div className="reserved-timer-summary reserved-timer-summary--header">
                      Reported: {effectiveReportedHours.toFixed(2)}h
                    </div>
                  </div>
                  <div className="reserved-timer-clock">{formatSeconds(timerElapsedSeconds)}</div>
                  {activeTrackedBlock && (
                    <div className="reserved-timer-progress">
                      <div className="reserved-timer-progress-track">
                        <div
                          className="reserved-timer-progress-fill"
                          style={{ width: `${activeTrackedProgressPct}%` }}
                        />
                      </div>
                      <span className="reserved-timer-progress-label">
                        {Math.max(0, activeTrackedBlock.myHours - (activeTrackedProgressPct / 100) * activeTrackedBlock.myHours).toFixed(2)}h left on {activeTrackedBlock.shiftName || activeTrackedBlock.workType}
                      </span>
                    </div>
                  )}
                  {timerRunning && (
                    <div className="reserved-timer-action reserved-timer-action--stop">
                      <button className="btn btn--ghost reserved-timer-button" onClick={handleStopWorking}>
                        Stop timer
                      </button>
                    </div>
                  )}
                </div>
                <div className={`reserved-blocks-right ${timerRunning ? "reserved-blocks-right--tracking" : ""}`}>
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
                      reservedBlocks.map((block) => {
                        const blockBookingId = block.bookings?.find((booking) => booking.isMine)?.id ?? null;
                        const isCurrentTask = timerRunning && timerBookingId != null && timerBookingId === blockBookingId;
                        const expired = isShiftExpired(block.dateKey, block.endTime, block.startTime);
                        const outsideShiftWindow = !expired && !isNowInShiftWindow(block.dateKey, block.startTime, block.endTime);
                        const willSwitchTimer = timerRunning && !isCurrentTask && !expired && !outsideShiftWindow;
                        const startDisabledReason = isOffline
                          ? "You're offline — reconnect to start tracking."
                          : expired
                          ? "This block has expired."
                          : outsideShiftWindow
                          ? `Cannot start — outside this block's working hours (${block.startTime}–${block.endTime}).`
                          : willSwitchTimer
                          ? `This will stop your timer on ${timerTaskName || "the current task"} and start tracking this block instead.`
                          : undefined;
                        const workedHours = blockBookingId != null ? (bookingBanked[blockBookingId] ?? 0) : 0;
                        // While this exact block is the one being actively tracked, fold the
                        // live stopwatch into the "worked so far" figure so the badge ticks
                        // down in real time instead of sitting frozen until the timer stops.
                        const liveWorkedHours = isCurrentTask ? workedHours + timerElapsedSeconds / 3600 : workedHours;
                        const remainingHours = Math.max(0, block.myHours - liveWorkedHours);
                        const hasPriorWork = workedHours > 0;
                        const progressPct = block.myHours > 0
                          ? Math.min(100, Math.max(0, (liveWorkedHours / block.myHours) * 100))
                          : 0;
                        // Step 8: workType and shiftName are very often the same word
                        // (e.g. "hubdoc" / "hubdoc") — only show the small eyebrow
                        // label above the title when it actually adds information.
                        const displayTitle = block.shiftName || block.workType || "Shift";
                        const showEyebrow = Boolean(block.workType) && block.workType !== displayTitle;
                        return (
                        <div key={block.id} className={`reserved-block-card reserved-block-card--task ${isCurrentTask ? "reserved-block-card--active" : ""}`}>
                        <div className="reserved-block-card-title-row">
                          <div>
                            {showEyebrow && <div className="reserved-block-card-label">{block.workType}</div>}
                            <div className={`reserved-block-card-title ${showEyebrow ? "" : "reserved-block-card-title--standalone"}`}>{displayTitle}</div>
                          </div>
                          <div className="reserved-block-card-meta">
                            <span className={`reserved-block-card-duration ${isCurrentTask ? "reserved-block-card-duration--live" : ""}`}>{remainingHours.toFixed(2)}h</span>
                            {isCurrentTask ? (
                              // Step 3: stopping now lives solely on the big timer card —
                              // this badge just reflects state, it doesn't duplicate the action.
                              <span className="reserved-block-card-tracking-badge">
                                <span className="reserved-block-card-tracking-dot" aria-hidden="true" />
                                Tracking
                              </span>
                            ) : (
                            <button
                              className={
                                `btn btn--ghost reserved-block-card-start ${
                                  expired || outsideShiftWindow || isOffline ? "btn--disabled" : ""
                                }`
                              }
                              disabled={(!timerRunning && expired) || isOffline}
                              onClick={async () => {
                                if (isOffline) {
                                  pushToast("warning", "You're offline — reconnect before starting the timer.");
                                  return;
                                }

                                if (expired) {
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

                                if (timerRunning) {
                                  // Switching tasks: stop (and bank) the currently running
                                  // timer before starting the newly selected block, rather
                                  // than blocking the user from switching.
                                  await handleStopWorking();
                                }

                                handleStartWorking(block.workType || block.shiftName || "Task", {
                                  bookingId: blockBookingId,
                                  blockId: block.id,
                                  dateKey: block.dateKey,
                                });
                              }}
                              title={startDisabledReason}
                            >
                              {expired ? "Expired" : hasPriorWork ? "Resume" : "Start timer"}
                            </button>
                            )}
                          </div>
                        </div>
                        <div className="reserved-block-card-progress-track">
                          <div
                            className={`reserved-block-card-progress-fill ${isCurrentTask ? "reserved-block-card-progress-fill--live" : ""}`}
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                        <div className="reserved-block-details">
                          between {block.dateKey} {block.startTime} to {block.endTime}
                        </div>
                      </div>
                        );
                      })
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
          {/* Bug fix: totalCommittedForActiveDate was being computed but
              HourGauge was never imported/rendered anywhere — surface it
              here next to the date picker so users can see today's 8h/day
              fill at a glance, live-updating with any in-progress claim. */}
          {!isAdmin && (
            <div className="board-rail-gauge">
              <span className="board-rail-gauge-label">{formatDateHeading(activeDate)}</span>
              <HourGauge committedHours={totalCommittedForActiveDate} pendingHours={pendingHours} />
            </div>
          )}
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
                    <span>End: {pendingBlock?.endTime ?? "17:00"}</span>
                  </div>
                  {pendingClaim.mode === "adjust" && pendingClaim.minHours > 0 && (
                    <p className="claim-modal-sub" style={{ color: "var(--amber)" }}>
                      You've already worked {pendingClaim.workedHours.toFixed(2)}h on this block — it can't be reduced below that.
                    </p>
                  )}
                  <label className="claim-modal-slider">
                    <span>{pendingClaim.hours}h</span>
                    <input
                      type="range"
                      min={pendingClaim.mode === "adjust" ? (pendingClaim.minHours ?? 0) : 0}
                      max={pendingClaim.maxHours}
                      step="1"
                      value={pendingClaim.hours}
                      onChange={(event) => handlePendingHoursChange(Number(event.target.value))}
                    />
                    <small>
                      {pendingClaim.mode === "adjust"
                        ? pendingClaim.minHours > 0
                          ? `Choose between ${pendingClaim.minHours}h and ${pendingClaim.maxHours}h.`
                          : `Choose between 0h and ${pendingClaim.maxHours}h; setting it to 0 cancels the reservation.`
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
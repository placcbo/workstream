# WorkBoard

A shared shift-release and booking board. Admins release blocks of work
capacity for projects they manage; workers claim hours from those blocks,
subject to per-project daily caps. A built-in timer lets workers track and
report time against their reservations.

## Stack

- **Frontend**: React (Vite), plain CSS (`index.css` for tokens/resets,
  `app.css` for components)
- **Backend**: Go (`main.go`) — the target backend; still partially mocked
- **Mock backend**: `data/mockApi.js`, an in-memory implementation of the
  same contract as the Go backend, used for local frontend development
  without running Go at all

The app is mid-migration from the mock backend to the real Go backend.
`data/backendApi.js` is the real HTTP client; `data/mockApi.js` is a
drop-in replacement with an identical function signature, so swapping
which one `BoardPage.jsx` imports from is the whole migration.

## Domain model

The work day runs **08:00 → 08:00 the next calendar day** (24 one-hour
slots), not midnight-to-midnight. This lets overnight shifts (e.g.
`16:00`–`00:00`, `22:00`–`02:00`) live on a single `dateKey` without
splitting across two calendar days. See `data/schedule.js` for the slot
math, lane-assignment layout algorithm, and date-range helpers.

Key concepts:

- **Project / work type**: a category an admin creates (e.g.
  "Extraction", "Cooking"). Admins have no built-in projects — they
  create their own from scratch.
- **Release block**: an admin releases a total number of hours for a
  date + project + shift window (`startTime`–`endTime`). Workers claim
  hours from it until it's full.
- **Booking**: a worker's claim against a block, in hours.
- **Per-project daily cap**: each worker has an independent 8h/day
  (configurable per block via `maxHoursPerUser`) cap *per project*, not
  combined — a worker granted both Extraction and Cooking can claim up to
  the cap in each, independently, on the same day.
- **Grants**: admins grant individual workers access to specific
  projects by email; access is stored as `{ workType: [emails...] }` and
  is case-insensitive on the project name.

## Visibility rules (important — previously buggy)

`fetchWeekSchedule(dateKeys, userId, isAdmin, userWorkTypes)` filters
which blocks a caller can see:

- `isAdmin === true` → no project filter; admin sees only blocks **they
  released** (`ownerId === userId`).
- `isAdmin === false`, `userWorkTypes === null` → no filter (used
  nowhere in practice; reserved for future use).
- `isAdmin === false`, `userWorkTypes === []` → **show nothing**. A
  worker with no granted projects must see zero blocks.
- `isAdmin === false`, `userWorkTypes === [...]` → show only blocks
  matching one of those project names.

⚠️ The Go backend's JSON unmarshalling does **not** automatically treat
an empty array the same as `null`/omitted — `encoding/json` only
produces a `nil` slice for JSON `null` or an absent key, not for `[]`.
Any handler doing `if payload.UserWorkTypes == nil` to mean "no filter"
will incorrectly treat `[]` (a worker with zero granted projects) as "no
filter" too, leaking every block to that worker. Distinguish "key
present but empty" from "key absent" explicitly in Go (e.g. with
`*[]string`, or by checking length separately from nilness) to match the
mock's behavior.

## Timer feature

Workers can start a stopwatch against a specific reserved block (from
the "Your reserved block(s)" panel, opened via the header's ⏱ button)
and stop it to bank the elapsed time as reported hours.

- The timer is bound to a specific **booking** (`bookingId` + `blockId`
  + `dateKey`), not a display name — two blocks with the same shift name
  or project name will not interfere with each other.
- Starting is only allowed inside the block's actual shift window
  (`startTime`–`endTime`), including overnight rollover (e.g.
  `22:00`–`02:00`).
- Timer state persists across reloads via `localStorage` so a worker can
  close the tab and the timer keeps running. On restore, elapsed time is
  capped at `MAX_PLAUSIBLE_TIMER_HOURS` (12h) — anything beyond that is
  treated as an abandoned timer, auto-stopped, and a capped amount is
  banked with a warning rather than silently trusting a multi-day-old
  timestamp.
- **Known limitation**: stopping the timer currently only refreshes the
  week summary from the backend for display purposes — it does not yet
  POST the tracked time to a backend endpoint. Reported time is tracked
  client-side (`reportedHoursOverride`, persisted per-user in
  `localStorage`) and added on top of `summary.reportedHours`. This is
  fine for a single device/browser but will not sync across devices and
  has no server-side durability. Wiring a real "log time" endpoint and
  reconciling/dropping the local override once confirmed is the
  follow-up item before this ships for real use.

## Project structure

```
src/
  pages/
    LoginPage.jsx        Mocked Google account picker
    BoardPage.jsx         Main app shell: week view, timer, all modals
  components/
    Header.jsx
    MiniMonth.jsx
    CalendarLayers.jsx    Layer toggles (Reserved / New Opportunities / Events)
    TimeInsights.jsx       Sidebar hours summary
    WeekGrid.jsx           The week calendar grid + capacity blocks
    AdminReleasePanel.jsx  Admin: release capacity, view project status
    AdminProjectsAndUsers.jsx  Admin: manage projects + per-project access
    AdminInsights.jsx      Admin: week-at-a-glance stats/charts
    HourGauge.jsx          Per-day hour budget gauge
  context/
    AuthContext.jsx        Mocked Google auth; work-type access/grants
  data/
    schedule.js            Domain model: dates, slots, lane layout
    backendApi.js           Real HTTP client (Go backend)
    mockApi.js               In-memory mock backend (same contract)
    mockApi_test.js           Node test runner tests for the mock backend
main.go                    Go backend (target implementation)
index.css                  Design tokens, resets
app.css                    All component styles
```

## Running locally

```bash
npm install
npm run dev
```

By default the app talks to whichever backend is wired up in
`pages/BoardPage.jsx`'s imports (`data/backendApi.js` for the real Go
server, `data/mockApi.js` for the in-memory mock). To run against the Go
backend, start it separately:

```bash
go run main.go
```

### Tests

The mock backend has a Node test-runner suite covering the capacity/
booking/cap logic:

```bash
node --test data/mockApi_test.js
```

## Known issues / follow-ups

- Timer time isn't persisted server-side yet (see Timer feature above).
- The Go backend's `userWorkTypes` nil-vs-empty-array handling needs
  fixing to match the mock's documented behavior (see Visibility rules
  above) — currently a worker with zero granted projects may see every
  block on the real backend.
- `AdminInsights`'s per-project color assignment falls back to amber for
  any project name not found in its `allNames` list; `WeekGrid`'s
  separate color cache assigns colors in first-seen-this-session order
  rather than a stable per-name order, so the same project can render in
  different colors across sessions.
- `AdminReleasePanel`'s default shift-time logic
  (`getDefaultTimesForDate`) determines "is this Saturday" using the
  browser's local timezone, while the rest of the app threads an
  explicit IANA timezone through to the backend for date-boundary
  decisions — worth aligning if admins and the work site aren't in the
  same timezone.

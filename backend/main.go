package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"golang.org/x/crypto/bcrypt"
)

//go:embed schema.sql
var schemaSQL string

// dbtx is satisfied by both *pgxpool.Pool and pgx.Tx, so every query helper
// below can run either directly against the pool (simple reads/writes) or
// inside an explicit transaction (check-then-write critical sections that
// need SELECT...FOR UPDATE — the Postgres analog of the mutex-guarded
// critical sections this file used to have around the in-memory store).
type dbtx interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

var db *pgxpool.Pool

func connectDB(ctx context.Context) *pgxpool.Pool {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("failed to create Postgres pool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("failed to reach Postgres at %s: %v", dsn, err)
	}
	if _, err := pool.Exec(ctx, schemaSQL); err != nil {
		log.Fatalf("failed to apply schema: %v", err)
	}
	return pool
}

func writeInternalError(w http.ResponseWriter, err error) {
	log.Printf("internal error: %v", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

type Block struct {
	ID              string `json:"id"`
	DateKey         string `json:"dateKey"`
	StartSlot       int    `json:"startSlot"`
	TotalHours      int    `json:"totalHours"`
	BlockSize       int    `json:"blockSize"`
	ShiftName       string `json:"shiftName"`
	StartTime       string `json:"startTime"`
	EndTime         string `json:"endTime"`
	WorkType        string `json:"workType"`
	OwnerID         string `json:"ownerId,omitempty"`
	MaxHoursPerUser int    `json:"maxHoursPerUser,omitempty"`
}

type User struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Email            string   `json:"email"`
	PasswordHash     string   `json:"-"`
	AvatarURL        string   `json:"avatarUrl,omitempty"`
	Role             string   `json:"role"`
	DefaultWorkTypes []string `json:"defaultWorkTypes"`
}

type Booking struct {
	ID      string `json:"id"`
	UserID  string `json:"userId"`
	DateKey string `json:"dateKey"`
	BlockID string `json:"blockId"`
	Hours   int    `json:"hours"`
}

type BlockResponse struct {
	Block
	Label          string          `json:"label"`
	EndSlot        int             `json:"endSlot"`
	ReservedHours  int             `json:"reservedHours"`
	RemainingHours int             `json:"remainingHours"`
	IsFull         bool            `json:"isFull"`
	MyHours        int             `json:"myHours"`
	Bookings       []BookingStatus `json:"bookings"`
}

type BookingStatus struct {
	Booking
	IsMine bool   `json:"isMine"`
	Status string `json:"status"`
}

type Summary struct {
	ReleasedHours  int `json:"releasedHours"`
	ReservedHours  int `json:"reservedHours"`
	RemainingHours int `json:"remainingHours"`
}

// Timer represents one user's currently-running work-tracking stopwatch.
// Only one active timer per user at a time; StartAt is a Unix millisecond
// timestamp so the client can compute elapsed time without trusting its own
// clock drift relative to the server.
type Timer struct {
	UserID    string `json:"userId"`
	StartAt   int64  `json:"startAt"`
	TaskName  string `json:"taskName"`
	BookingID string `json:"bookingId,omitempty"`
	BlockID   string `json:"blockId,omitempty"`
	DateKey   string `json:"dateKey,omitempty"`
}

// Notification is a persistent, per-user in-app notice — e.g. "your timer
// was auto-stopped" or "an admin moved a shift you already claimed". Kept
// server-side (rather than a client-only toast) so it survives a page
// reload and is visible even if the user wasn't looking when it happened.
type Notification struct {
	ID        string `json:"id"`
	UserID    string `json:"-"`
	Kind      string `json:"kind"`
	Message   string `json:"message"`
	CreatedAt int64  `json:"createdAt"`
	Read      bool   `json:"read"`
}

// maxNotificationsPerUser bounds table growth — older notifications are
// dropped once a user exceeds this count.
const maxNotificationsPerUser = 50

// addNotification records a new notification for userID, newest first, and
// enforces maxNotificationsPerUser by trimming anything older off the end.
func addNotification(ctx context.Context, q dbtx, userID, kind, message string) error {
	if _, err := q.Exec(ctx,
		`INSERT INTO notifications (user_id, kind, message, created_at) VALUES ($1, $2, $3, $4)`,
		userID, kind, message, time.Now().UnixMilli(),
	); err != nil {
		return err
	}
	_, err := q.Exec(ctx, `
		DELETE FROM notifications
		WHERE user_id = $1 AND id NOT IN (
			SELECT id FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2
		)`, userID, maxNotificationsPerUser)
	return err
}

// MaxPlausibleTimerHours mirrors the client-side cap: if a timer has been
// running longer than this (e.g. the tab was closed and reopened days
// later), we don't trust the elapsed time as real tracked work.
const maxPlausibleTimerHours = 12

var defaultAdminInviteCode string

const dayStartHour = 8
const slotsPerDay = 24
const maxHoursPerDay = 8

func writeJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

func withCORS(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Session-Id, X-Requested-With, Accept, Origin")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		fn(w, r)
	}
}

type rateLimiterEntry struct {
	count     int
	windowEnd time.Time
}

type rateLimiter struct {
	mu      sync.Mutex
	entries map[string]*rateLimiterEntry
	limit   int
	window  time.Duration
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{
		entries: make(map[string]*rateLimiterEntry),
		limit:   limit,
		window:  window,
	}
}

func (rl *rateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	entry, ok := rl.entries[key]
	now := time.Now()
	if !ok || now.After(entry.windowEnd) {
		rl.entries[key] = &rateLimiterEntry{count: 1, windowEnd: now.Add(rl.window)}
		return true
	}
	if entry.count >= rl.limit {
		return false
	}
	entry.count++
	return true
}

// getRemoteIP returns the actual TCP peer address for rate-limiting
// purposes. It deliberately ignores X-Forwarded-For/X-Real-IP: there is no
// trusted-proxy allowlist in this codebase, and honoring client-supplied
// headers would let an attacker bypass the login/register rate limiter by
// sending a different value on every request.
func getRemoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func withRateLimit(fn http.HandlerFunc, rl *rateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		remoteIP := getRemoteIP(r)
		if !rl.allow(remoteIP) {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "rate limit exceeded"})
			return
		}
		fn(w, r)
	}
}

func parseDateKey(value string) (time.Time, error) {
	return time.Parse("2006-01-02", value)
}

// parseTimeOfDay parses an "HH:MM" string into hour/minute, defaulting to
// 8:00 (the work-day start) if the value is missing or malformed.
func parseTimeOfDay(value string) (int, int) {
	parts := strings.Split(value, ":")
	if len(parts) != 2 {
		return dayStartHour, 0
	}
	hour, err1 := strconv.Atoi(parts[0])
	minute, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return dayStartHour, 0
	}
	return hour, minute
}

// shiftEndDateTime is the real calendar Date+time a shift window
// (startTime -> endTime, e.g. "08:00" -> "17:00") ends at on `dateKey`.
// Unlike a slot-based calculation, this does NOT depend on a block's
// TotalHours at all — TotalHours is pooled capacity (can be 50, 200,
// anything) and is completely decoupled from how long the actual shift
// window is. If endTime is <= startTime the shift is treated as rolling
// past midnight into the next calendar day.
func shiftEndDateTime(dateKey, startTime, endTime string) time.Time {
	base, err := parseDateKey(dateKey)
	if err != nil {
		return time.Time{}
	}
	startHour, startMin := parseTimeOfDay(startTime)
	endHour, endMin := parseTimeOfDay(endTime)
	startMins := startHour*60 + startMin
	endMins := endHour*60 + endMin
	dayOffset := 0
	if endMins <= startMins {
		dayOffset = 1
	}
	return time.Date(base.Year(), base.Month(), base.Day()+dayOffset, endHour, endMin, 0, 0, time.Local)
}

// deriveShiftBookingStatus derives RESERVED vs COMPLETED for a booking
// using the block's real startTime/endTime shift window, instead of
// TotalHours. This is the correct completion check post-AdminReleasePanel
// redesign, where TotalHours is pooled capacity, not shift duration.
func deriveShiftBookingStatus(dateKey, startTime, endTime string) string {
	now := time.Now()
	if !shiftEndDateTime(dateKey, startTime, endTime).After(now) {
		return "completed"
	}
	return "reserved"
}

func blockEndSlot(block Block) int {
	return block.StartSlot + int(math.Max(1, math.Ceil(float64(block.TotalHours)))) - 1
}

func buildDateRange(startDate time.Time, count int) []string {
	out := make([]string, 0, count)
	for i := 0; i < count; i++ {
		d := startDate.AddDate(0, 0, i)
		out = append(out, d.Format("2006-01-02"))
	}
	return out
}

func startOfWeek(date time.Time) time.Time {
	d := date.Truncate(24 * time.Hour)
	offset := int(d.Weekday())
	return d.AddDate(0, 0, -offset)
}

func buildWeekRange(date time.Time) []string {
	return buildDateRange(startOfWeek(date), 7)
}

func buildBlocks(totalHours int, blockSize int, startSlot int) []Block {
	blocks := make([]Block, 0)
	remaining := totalHours
	cursor := startSlot
	for remaining > 0 {
		hours := remaining
		if hours > blockSize {
			hours = blockSize
		}
		blocks = append(blocks, Block{
			StartSlot:  cursor,
			TotalHours: hours,
			BlockSize:  blockSize,
		})
		remaining -= hours
		cursor += int(math.Ceil(float64(hours)))
	}
	return blocks
}

// getBlockBookings returns every booking for a block.
func getBlockBookings(ctx context.Context, q dbtx, blockID string) ([]Booking, error) {
	rows, err := q.Query(ctx, `SELECT id, user_id, date_key, block_id, hours FROM bookings WHERE block_id = $1`, blockID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bookings := make([]Booking, 0)
	for rows.Next() {
		var b Booking
		if err := rows.Scan(&b.ID, &b.UserID, &b.DateKey, &b.BlockID, &b.Hours); err != nil {
			return nil, err
		}
		bookings = append(bookings, b)
	}
	return bookings, rows.Err()
}

func reservedForBlock(ctx context.Context, q dbtx, blockID string) (int, error) {
	var sum int
	err := q.QueryRow(ctx, `SELECT COALESCE(SUM(hours), 0) FROM bookings WHERE block_id = $1`, blockID).Scan(&sum)
	return sum, err
}

func remainingForBlock(ctx context.Context, q dbtx, block Block) (int, error) {
	reserved, err := reservedForBlock(ctx, q, block.ID)
	if err != nil {
		return 0, err
	}
	return int(math.Max(0, float64(block.TotalHours-reserved))), nil
}

// normalizeEmail mirrors AuthContext.jsx's normalizeEmail: trim + lowercase
// so grants are matched consistently regardless of how the email was typed.
func normalizeEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func hashPassword(password string) string {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		log.Fatalf("failed to hash password: %v", err)
	}
	return string(hash)
}

func passwordMatches(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// userHoursForDayAndWorkType sums hours booked by userID on dateKey against
// blocks of the given workType, optionally excluding one booking (used when
// editing a booking, to compute "everything else I have that day").
func userHoursForDayAndWorkType(ctx context.Context, q dbtx, dateKey, userID, workType, excludeBookingID string) (int, error) {
	var sum int
	err := q.QueryRow(ctx, `
		SELECT COALESCE(SUM(b.hours), 0)
		FROM bookings b
		JOIN release_blocks rb ON rb.id = b.block_id
		WHERE b.date_key = $1 AND b.user_id = $2 AND rb.work_type = $3 AND b.id != $4
	`, dateKey, userID, workType, excludeBookingID).Scan(&sum)
	return sum, err
}

func bookingBankedForUser(ctx context.Context, q dbtx, userID string) (map[string]float64, error) {
	rows, err := q.Query(ctx, `
		SELECT bb.booking_id, bb.hours
		FROM booking_banked bb
		JOIN bookings b ON b.id = bb.booking_id
		WHERE b.user_id = $1 AND bb.hours > 0
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]float64)
	for rows.Next() {
		var id string
		var hours float64
		if err := rows.Scan(&id, &hours); err != nil {
			return nil, err
		}
		result[id] = hours
	}
	return result, rows.Err()
}

func getReportedOverride(ctx context.Context, q dbtx, userID string) (float64, error) {
	var hours float64
	err := q.QueryRow(ctx, `SELECT hours FROM reported_override WHERE user_id = $1`, userID).Scan(&hours)
	if err == pgx.ErrNoRows {
		return 0, nil
	}
	return hours, err
}

// bankTimerSeconds banks `cappedSeconds` worth of elapsed work for `timer`
// into reported_override (and booking_banked, if the timer was tied to a
// specific booking), deletes the timer row, and returns the hours added.
// Callers that need this atomic with other writes must pass a transaction.
func bankTimerSeconds(ctx context.Context, q dbtx, userID string, timer *Timer, cappedSeconds float64) (float64, error) {
	addedHours := math.Round((cappedSeconds/3600)*100) / 100
	// Bank elapsed hours immediately, even for booking-tied timers — partial
	// work should show up in reported hours right away rather than waiting
	// for the whole shift to complete. See handleUserHoursSummary for how
	// double-counting against the eventual completed-booking hours is
	// avoided via booking_banked.
	if _, err := q.Exec(ctx, `
		INSERT INTO reported_override (user_id, hours) VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET hours = reported_override.hours + $2
	`, userID, addedHours); err != nil {
		return 0, err
	}
	if timer.BookingID != "" {
		if _, err := q.Exec(ctx, `
			INSERT INTO booking_banked (booking_id, hours) VALUES ($1, $2)
			ON CONFLICT (booking_id) DO UPDATE SET hours = booking_banked.hours + $2
		`, timer.BookingID, addedHours); err != nil {
			return 0, err
		}
	}
	if _, err := q.Exec(ctx, `DELETE FROM timers WHERE user_id = $1`, userID); err != nil {
		return 0, err
	}
	return addedHours, nil
}

func serializeBlock(ctx context.Context, q dbtx, block Block, currentUserID string) (BlockResponse, error) {
	blockBookings, err := getBlockBookings(ctx, q, block.ID)
	if err != nil {
		return BlockResponse{}, err
	}
	reservedHours := 0
	myHours := 0
	bookingsResp := make([]BookingStatus, 0, len(blockBookings))
	for _, booking := range blockBookings {
		reservedHours += booking.Hours
		if booking.UserID == currentUserID {
			myHours += booking.Hours
		}
		bookingsResp = append(bookingsResp, BookingStatus{
			Booking: booking,
			IsMine:  booking.UserID == currentUserID,
			Status:  deriveShiftBookingStatus(booking.DateKey, block.StartTime, block.EndTime),
		})
	}
	remainingHours := int(math.Max(0, float64(block.TotalHours-reservedHours)))
	return BlockResponse{
		Block:          block,
		Label:          fmt.Sprintf("%02d:00 start", (dayStartHour+block.StartSlot)%24),
		EndSlot:        blockEndSlot(block),
		ReservedHours:  reservedHours,
		RemainingHours: remainingHours,
		IsFull:         remainingHours <= 0,
		MyHours:        myHours,
		Bookings:       bookingsResp,
	}, nil
}

// releaseBlocksForDate returns every release block on a date — a pure read,
// used by read-only aggregation paths (no FOR UPDATE; getBlockByID below is
// the locking variant used by check-then-write handlers).
func releaseBlocksForDate(ctx context.Context, q dbtx, dateKey string) ([]Block, error) {
	rows, err := q.Query(ctx, `
		SELECT id, date_key, start_slot, total_hours, block_size, shift_name, start_time, end_time, work_type, owner_id, max_hours_per_user
		FROM release_blocks WHERE date_key = $1
	`, dateKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	blocks := make([]Block, 0)
	for rows.Next() {
		var b Block
		if err := rows.Scan(&b.ID, &b.DateKey, &b.StartSlot, &b.TotalHours, &b.BlockSize, &b.ShiftName, &b.StartTime, &b.EndTime, &b.WorkType, &b.OwnerID, &b.MaxHoursPerUser); err != nil {
			return nil, err
		}
		blocks = append(blocks, b)
	}
	return blocks, rows.Err()
}

// getBlockByID looks up a single block and locks its row FOR UPDATE — every
// caller uses this from inside a transaction that's about to validate a
// claim against the block's capacity and then write, so the lock matters.
func getBlockByID(ctx context.Context, q dbtx, dateKey, blockID string) (Block, bool, error) {
	var b Block
	err := q.QueryRow(ctx, `
		SELECT id, date_key, start_slot, total_hours, block_size, shift_name, start_time, end_time, work_type, owner_id, max_hours_per_user
		FROM release_blocks WHERE date_key = $1 AND id = $2 FOR UPDATE
	`, dateKey, blockID).Scan(&b.ID, &b.DateKey, &b.StartSlot, &b.TotalHours, &b.BlockSize, &b.ShiftName, &b.StartTime, &b.EndTime, &b.WorkType, &b.OwnerID, &b.MaxHoursPerUser)
	if err == pgx.ErrNoRows {
		return Block{}, false, nil
	}
	if err != nil {
		return Block{}, false, err
	}
	return b, true, nil
}

func summarizeDateForOwner(ctx context.Context, q dbtx, dateKey, ownerID string) (Summary, error) {
	blocks, err := releaseBlocksForDate(ctx, q, dateKey)
	if err != nil {
		return Summary{}, err
	}
	releasedHours := 0
	reservedHours := 0
	for _, block := range blocks {
		// When ownerID is provided, only count this admin's own blocks.
		if ownerID != "" && block.OwnerID != ownerID {
			continue
		}
		releasedHours += block.TotalHours
		reserved, err := reservedForBlock(ctx, q, block.ID)
		if err != nil {
			return Summary{}, err
		}
		reservedHours += reserved
	}
	return Summary{
		ReleasedHours:  releasedHours,
		ReservedHours:  reservedHours,
		RemainingHours: int(math.Max(0, float64(releasedHours-reservedHours))),
	}, nil
}

func handleWeekRange(w http.ResponseWriter, r *http.Request) {
	anchorDate := r.URL.Query().Get("anchorDate")
	if anchorDate == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "anchorDate is required"})
		return
	}
	parsed, err := parseDateKey(anchorDate)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid anchorDate format"})
		return
	}
	writeJSON(w, http.StatusOK, buildWeekRange(parsed))
}

func handleWeekSchedule(w http.ResponseWriter, r *http.Request) {
	account, ok := requireSessionAccount(w, r)
	if !ok {
		return
	}
	var payload struct {
		DateKeys []string `json:"dateKeys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}

	ctx := r.Context()
	response := map[string]struct {
		Blocks  []BlockResponse `json:"blocks"`
		Summary Summary         `json:"summary"`
	}{}

	allowedWorkTypes := map[string]struct{}{}
	if account.Role != "admin" {
		granted, err := resolveGrantedWorkTypesForEmail(ctx, db, account.Email, account.DefaultWorkTypes)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		for _, wt := range granted {
			allowedWorkTypes[wt] = struct{}{}
		}
	}

	for _, dateKey := range payload.DateKeys {
		dateBlocks, err := releaseBlocksForDate(ctx, db, dateKey)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		blocks := make([]BlockResponse, 0)
		for _, block := range dateBlocks {
			if account.Role == "admin" {
				if block.OwnerID == account.ID {
					sb, err := serializeBlock(ctx, db, block, account.ID)
					if err != nil {
						writeInternalError(w, err)
						return
					}
					blocks = append(blocks, sb)
				}
				continue
			}
			if _, ok := allowedWorkTypes[block.WorkType]; ok {
				sb, err := serializeBlock(ctx, db, block, account.ID)
				if err != nil {
					writeInternalError(w, err)
					return
				}
				blocks = append(blocks, sb)
			}
		}
		releasedHours := 0
		reservedHours := 0
		for _, block := range blocks {
			releasedHours += block.TotalHours
			reservedHours += block.ReservedHours
		}
		response[dateKey] = struct {
			Blocks  []BlockResponse `json:"blocks"`
			Summary Summary         `json:"summary"`
		}{
			Blocks: blocks,
			Summary: Summary{
				ReleasedHours:  releasedHours,
				ReservedHours:  reservedHours,
				RemainingHours: int(math.Max(0, float64(releasedHours-reservedHours))),
			},
		}
	}
	writeJSON(w, http.StatusOK, response)
}

func handleUserHours(w http.ResponseWriter, r *http.Request) {
	account, ok := requireSessionAccount(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	dateKey := query.Get("dateKey")
	userID := query.Get("userId")
	workType := query.Get("workType")
	if account.Role != "admin" && userID != account.ID {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return
	}
	result, err := userHoursForDayAndWorkType(r.Context(), db, dateKey, userID, workType, "")
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func handleUserHoursSummary(w http.ResponseWriter, r *http.Request) {
	account, ok := requireSessionAccount(w, r)
	if !ok {
		return
	}
	var payload struct {
		DateKeys []string `json:"dateKeys"`
		UserID   string   `json:"userId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if account.Role != "admin" && payload.UserID != account.ID {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return
	}
	ctx := r.Context()
	dateSet := make(map[string]struct{}, len(payload.DateKeys))
	for _, k := range payload.DateKeys {
		dateSet[k] = struct{}{}
	}

	rows, err := db.Query(ctx, `
		SELECT b.hours, b.date_key, rb.start_time, rb.end_time, COALESCE(bb.hours, 0)
		FROM bookings b
		JOIN release_blocks rb ON rb.id = b.block_id
		LEFT JOIN booking_banked bb ON bb.booking_id = b.id
		WHERE b.user_id = $1
	`, payload.UserID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	defer rows.Close()

	reportedHours := 0.0
	reservedHours := 0
	for rows.Next() {
		var dateKey, startTime, endTime string
		var hours int
		var banked float64
		if err := rows.Scan(&hours, &dateKey, &startTime, &endTime, &banked); err != nil {
			writeInternalError(w, err)
			return
		}
		if _, ok := dateSet[dateKey]; !ok {
			continue
		}
		reservedHours += hours
		if deriveShiftBookingStatus(dateKey, startTime, endTime) == "completed" {
			// Subtract whatever's already been banked for this booking via
			// stopped timers (handleStopTimer / handleGetTimer auto-stop) —
			// that portion is already counted client-side through
			// reportedOverride, so adding the full booking hours here too
			// would double-count it.
			remaining := float64(hours) - banked
			if remaining > 0 {
				reportedHours += remaining
			}
		}
	}
	if err := rows.Err(); err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reportedHours": reportedHours, "reservedHours": reservedHours})
}

func handleAdminCapacitySummary(w http.ResponseWriter, r *http.Request) {
	account, ok := requireAdminAccount(w, r)
	if !ok {
		return
	}
	var payload struct {
		DateKeys []string `json:"dateKeys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	ctx := r.Context()
	response := make(map[string]Summary)
	for _, dateKey := range payload.DateKeys {
		summary, err := summarizeDateForOwner(ctx, db, dateKey, account.ID)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		response[dateKey] = summary
	}
	writeJSON(w, http.StatusOK, response)
}

func handleReleaseHours(w http.ResponseWriter, r *http.Request) {
	account, ok := requireAdminAccount(w, r)
	if !ok {
		return
	}
	var payload struct {
		DateKey         string `json:"dateKey"`
		TotalHours      int    `json:"totalHours"`
		BlockSize       int    `json:"blockSize"`
		StartSlot       int    `json:"startSlot"`
		ShiftName       string `json:"shiftName"`
		StartTime       string `json:"startTime"`
		EndTime         string `json:"endTime"`
		WorkType        string `json:"workType"`
		MaxHoursPerUser int    `json:"maxHoursPerUser"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if payload.TotalHours < 1 {
		payload.TotalHours = 1
	}
	if payload.BlockSize < 1 {
		payload.BlockSize = 1
	}
	created, err := addRelease(r.Context(), payload.DateKey, payload.TotalHours, payload.BlockSize, payload.StartSlot, payload.ShiftName, payload.StartTime, payload.EndTime, payload.WorkType, account.ID, payload.MaxHoursPerUser)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "created": created})
}

// addRelease creates a new release block, or — if one already exists on this
// date for the same project/owner/shift window — tops up its hours instead
// of stacking a duplicate. Without this, re-clicking "Release" (or a
// recurring release whose pattern happens to land on a date that already
// has a manual release) creates several skinny side-by-side blocks for what
// the admin sees as "one release". Runs in its own transaction with the
// matching row locked FOR UPDATE, since two concurrent releases landing on
// the same existing block must not both read the same TotalHours and race.
func addRelease(ctx context.Context, dateKey string, totalHours, blockSize, startSlot int, shiftName, startTime, endTime, workType, ownerId string, maxHoursPerUser int) ([]Block, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT id, date_key, start_slot, total_hours, block_size, shift_name, start_time, end_time, work_type, owner_id, max_hours_per_user
		FROM release_blocks
		WHERE date_key = $1 AND work_type = $2 AND owner_id = $3 AND start_time = $4 AND end_time = $5
		FOR UPDATE`, dateKey, workType, ownerId, startTime, endTime)
	if err != nil {
		return nil, err
	}
	var existing *Block
	if rows.Next() {
		var b Block
		if err := rows.Scan(&b.ID, &b.DateKey, &b.StartSlot, &b.TotalHours, &b.BlockSize, &b.ShiftName, &b.StartTime, &b.EndTime, &b.WorkType, &b.OwnerID, &b.MaxHoursPerUser); err != nil {
			rows.Close()
			return nil, err
		}
		existing = &b
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if existing != nil {
		newTotal := existing.TotalHours + totalHours
		newMax := existing.MaxHoursPerUser
		// Only set/raise MaxHoursPerUser — don't silently lower it and risk
		// orphaning or invalidating existing bookings.
		if maxHoursPerUser > 0 && (newMax == 0 || maxHoursPerUser > newMax) {
			newMax = maxHoursPerUser
		}
		if _, err := tx.Exec(ctx, `UPDATE release_blocks SET total_hours = $1, block_size = $1, max_hours_per_user = $2 WHERE id = $3`, newTotal, newMax, existing.ID); err != nil {
			return nil, err
		}
		existing.TotalHours = newTotal
		existing.BlockSize = newTotal
		existing.MaxHoursPerUser = newMax
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return []Block{*existing}, nil
	}

	blocks := buildBlocks(totalHours, blockSize, startSlot)
	created := make([]Block, 0, len(blocks))
	for _, block := range blocks {
		block.DateKey = dateKey
		block.ShiftName = shiftName
		block.StartTime = startTime
		block.EndTime = endTime
		block.WorkType = workType
		block.OwnerID = ownerId
		if maxHoursPerUser > 0 {
			block.MaxHoursPerUser = maxHoursPerUser
		}
		err := tx.QueryRow(ctx, `
			INSERT INTO release_blocks (date_key, start_slot, total_hours, block_size, shift_name, start_time, end_time, work_type, owner_id, max_hours_per_user)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			RETURNING id`,
			block.DateKey, block.StartSlot, block.TotalHours, block.BlockSize, block.ShiftName, block.StartTime, block.EndTime, block.WorkType, block.OwnerID, block.MaxHoursPerUser,
		).Scan(&block.ID)
		if err != nil {
			return nil, err
		}
		created = append(created, block)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return created, nil
}

// recurringDateKeys computes the list of work-day dateKeys (YYYY-MM-DD) a
// recurring release should land on, given a frequency, an inclusive
// [startDate, endDate] range, and (for daily/weekly) the set of weekdays to
// include. Weekday values follow Go's time.Weekday: Sunday=0 ... Saturday=6.
//
//   - "daily"/"weekly": walk every calendar day in the range and keep the
//     ones whose weekday is in `weekdays`. This single mechanism covers both
//     "every day" (all 7 selected) and "just Mondays" (1 selected) — the
//     distinction between the two frequency labels is purely about how the
//     admin thinks about the pattern, not a different algorithm. An empty
//     `weekdays` set falls back to every day, so the frequency still does
//     something sensible even if the picker was left untouched.
//   - "monthly": start on `startDate` and step forward one calendar month at
//     a time (so the 31st rolls correctly via time.AddDate) until past
//     `endDate`.
func recurringDateKeys(startDate, endDate time.Time, frequency string, weekdays map[int]bool) []string {
	keys := make([]string, 0)
	if endDate.Before(startDate) {
		return keys
	}
	if frequency == "monthly" {
		for cursor := startDate; !cursor.After(endDate); cursor = cursor.AddDate(0, 1, 0) {
			keys = append(keys, cursor.Format("2006-01-02"))
		}
		return keys
	}
	includeAll := len(weekdays) == 0
	for cursor := startDate; !cursor.After(endDate); cursor = cursor.AddDate(0, 0, 1) {
		if includeAll || weekdays[int(cursor.Weekday())] {
			keys = append(keys, cursor.Format("2006-01-02"))
		}
	}
	return keys
}

func handleReleaseHoursRecurring(w http.ResponseWriter, r *http.Request) {
	account, ok := requireAdminAccount(w, r)
	if !ok {
		return
	}
	var payload struct {
		StartDate       string `json:"startDate"`
		EndDate         string `json:"endDate"`
		Frequency       string `json:"frequency"` // "daily" | "weekly" | "monthly"
		Weekdays        []int  `json:"weekdays"`  // 0=Sun..6=Sat, used for daily/weekly
		TotalHours      int    `json:"totalHours"`
		ShiftName       string `json:"shiftName"`
		StartTime       string `json:"startTime"`
		EndTime         string `json:"endTime"`
		WorkType        string `json:"workType"`
		MaxHoursPerUser int    `json:"maxHoursPerUser"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	startDate, err := time.Parse("2006-01-02", payload.StartDate)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Invalid start date."})
		return
	}
	endDate, err := time.Parse("2006-01-02", payload.EndDate)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Invalid end date."})
		return
	}
	if endDate.Before(startDate) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "End date must be on or after the start date."})
		return
	}
	if payload.Frequency != "daily" && payload.Frequency != "weekly" && payload.Frequency != "monthly" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Frequency must be daily, weekly, or monthly."})
		return
	}
	if payload.Frequency != "monthly" && len(payload.Weekdays) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Pick at least one day of the week."})
		return
	}
	if payload.TotalHours < 1 {
		payload.TotalHours = 1
	}

	weekdaySet := make(map[int]bool, len(payload.Weekdays))
	for _, d := range payload.Weekdays {
		if d >= 0 && d <= 6 {
			weekdaySet[d] = true
		}
	}
	dateKeys := recurringDateKeys(startDate, endDate, payload.Frequency, weekdaySet)
	// Cap how far a single recurring release can fan out so a typo in the
	// end date (e.g. a stray extra year) can't silently create thousands of
	// blocks.
	const maxOccurrences = 366
	if len(dateKeys) > maxOccurrences {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("That pattern would create %d releases — narrow the date range (max %d).", len(dateKeys), maxOccurrences)})
		return
	}
	if len(dateKeys) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "No matching days fall inside that date range."})
		return
	}

	// TotalHours is the size of the whole pool the admin is releasing over
	// the recurring period (e.g. "500h total, released weekly"), NOT the
	// amount released on every single occurrence — otherwise a 50h release
	// repeating weekly for a month would silently hand out 200h+. Split it
	// evenly across the matching dates, with any remainder (from hours not
	// dividing evenly) spread across the first few dates so the total adds
	// up exactly.
	occurrences := len(dateKeys)
	if payload.TotalHours < occurrences {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    false,
			"error": fmt.Sprintf("%dh isn't enough to spread across %d releases (1h minimum each) — raise the total or shorten the range.", payload.TotalHours, occurrences),
		})
		return
	}
	baseHoursPerDate := payload.TotalHours / occurrences
	remainder := payload.TotalHours % occurrences

	ctx := r.Context()
	createdByDate := make(map[string][]Block, len(dateKeys))
	totalBlocksCreated := 0
	for i, dateKey := range dateKeys {
		hoursForDate := baseHoursPerDate
		if i < remainder {
			hoursForDate++
		}
		created, err := addRelease(ctx, dateKey, hoursForDate, hoursForDate, 0, payload.ShiftName, payload.StartTime, payload.EndTime, payload.WorkType, account.ID, payload.MaxHoursPerUser)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		createdByDate[dateKey] = created
		totalBlocksCreated += len(created)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                 true,
		"createdByDate":      createdByDate,
		"datesCount":         len(dateKeys),
		"totalBlocksCreated": totalBlocksCreated,
		"hoursPerDate":       baseHoursPerDate,
		"dateKeys":           dateKeys,
	})
}

func handleAdjustReleasedHours(w http.ResponseWriter, r *http.Request) {
	account, ok := requireAdminAccount(w, r)
	if !ok {
		return
	}
	var payload struct {
		DateKey         string `json:"dateKey"`
		BlockID         string `json:"blockId"`
		TotalHours      int    `json:"totalHours"`
		ShiftName       string `json:"shiftName"`
		StartTime       string `json:"startTime"`
		EndTime         string `json:"endTime"`
		WorkType        string `json:"workType"`
		MaxHoursPerUser int    `json:"maxHoursPerUser"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	ctx := r.Context()
	tx, err := db.Begin(ctx)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	defer tx.Rollback(ctx)

	block, found, err := getBlockByID(ctx, tx, payload.DateKey, payload.BlockID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if !found {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Block not found."})
		return
	}
	if block.OwnerID != account.ID {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return
	}

	reserved, err := reservedForBlock(ctx, tx, block.ID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	normalizedTotal := payload.TotalHours
	if normalizedTotal < 1 {
		normalizedTotal = 1
	}
	if normalizedTotal < reserved {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("Can't reduce below %dh — that's already claimed on this block.", reserved)})
		return
	}
	// Bug fix: changing a block's workType after users have already claimed
	// hours on it silently orphans their bookings — handleWeekSchedule
	// filters blocks by the project(s) a user has been granted, so a
	// claimant without access to the NEW workType would stop seeing a block
	// they still have hours reserved on, while those hours still count
	// against their day in handleUserHoursSummary. Reassigning the project
	// is only safe once nobody has claimed anything from this block yet.
	trimmedWorkType := strings.TrimSpace(payload.WorkType)
	if trimmedWorkType != "" && trimmedWorkType != block.WorkType && reserved > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("Can't change the project — %dh are already claimed on this block under %q.", reserved, block.WorkType)})
		return
	}

	originalStartTime, originalEndTime := block.StartTime, block.EndTime
	updated := block
	updated.TotalHours = normalizedTotal
	updated.BlockSize = normalizedTotal
	if payload.ShiftName != "" {
		updated.ShiftName = payload.ShiftName
	}
	if payload.StartTime != "" {
		updated.StartTime = payload.StartTime
	}
	if payload.EndTime != "" {
		updated.EndTime = payload.EndTime
	}
	if payload.WorkType != "" {
		updated.WorkType = payload.WorkType
	}

	if payload.MaxHoursPerUser > 0 {
		// Ensure lowering the per-user cap doesn't invalidate existing
		// reservations: compute per-user reserved hours on this block and
		// reject the change if any user already exceeds the requested cap.
		rows, err := tx.Query(ctx, `SELECT user_id, SUM(hours) FROM bookings WHERE block_id = $1 GROUP BY user_id`, block.ID)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		var capError string
		for rows.Next() {
			var uid string
			var sum int
			if err := rows.Scan(&uid, &sum); err != nil {
				rows.Close()
				writeInternalError(w, err)
				return
			}
			if sum > payload.MaxHoursPerUser {
				capError = fmt.Sprintf("Can't set maxHoursPerUser to %dh — user %s already has %dh reserved on this block.", payload.MaxHoursPerUser, uid, sum)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			writeInternalError(w, err)
			return
		}
		if capError != "" {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": capError})
			return
		}
		updated.MaxHoursPerUser = payload.MaxHoursPerUser
	}

	if _, err := tx.Exec(ctx, `
		UPDATE release_blocks SET total_hours=$1, block_size=$2, shift_name=$3, start_time=$4, end_time=$5, work_type=$6, max_hours_per_user=$7
		WHERE id = $8`,
		updated.TotalHours, updated.BlockSize, updated.ShiftName, updated.StartTime, updated.EndTime, updated.WorkType, updated.MaxHoursPerUser, updated.ID,
	); err != nil {
		writeInternalError(w, err)
		return
	}

	// A worker who already claimed hours on this block has no other way to
	// learn their shift window moved — everything else this handler can
	// change is already guarded against affecting an existing claim (total
	// can't drop below reserved, workType can't change once claimed), so a
	// start/end time change is the one case that legitimately needs to
	// reach them.
	timeChanged := (updated.StartTime != originalStartTime) || (updated.EndTime != originalEndTime)
	if timeChanged && reserved > 0 {
		bookings, err := getBlockBookings(ctx, tx, updated.ID)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		notified := map[string]bool{}
		for _, b := range bookings {
			if notified[b.UserID] {
				continue
			}
			notified[b.UserID] = true
			if err := addNotification(ctx, tx, b.UserID, "shift_time_changed", fmt.Sprintf(
				"Your %s shift on %s was moved to %s–%s.",
				updated.WorkType, payload.DateKey, updated.StartTime, updated.EndTime,
			)); err != nil {
				writeInternalError(w, err)
				return
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updated": updated})
}

func handleRevokeBlock(w http.ResponseWriter, r *http.Request) {
	account, ok := requireAdminAccount(w, r)
	if !ok {
		return
	}
	var payload struct {
		DateKey string `json:"dateKey"`
		BlockID string `json:"blockId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	ctx := r.Context()
	tx, err := db.Begin(ctx)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	defer tx.Rollback(ctx)

	block, found, err := getBlockByID(ctx, tx, payload.DateKey, payload.BlockID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if !found {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Block not found."})
		return
	}
	if block.OwnerID != account.ID {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return
	}
	reserved, err := reservedForBlock(ctx, tx, payload.BlockID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if reserved > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "This block already has reservations."})
		return
	}
	if _, err := tx.Exec(ctx, `DELETE FROM release_blocks WHERE id = $1`, payload.BlockID); err != nil {
		writeInternalError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleReserveHours(w http.ResponseWriter, r *http.Request) {
	account, ok := requireSessionAccount(w, r)
	if !ok {
		return
	}
	var payload struct {
		DateKey        string `json:"dateKey"`
		BlockID        string `json:"blockId"`
		Hours          int    `json:"hours"`
		UserID         string `json:"userId"`
		MaxHoursPerDay int    `json:"maxHoursPerDay"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	payload.UserID = account.ID
	if payload.Hours < 1 {
		payload.Hours = 1
	}
	ctx := r.Context()
	tx, err := db.Begin(ctx)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	defer tx.Rollback(ctx)

	block, found, err := getBlockByID(ctx, tx, payload.DateKey, payload.BlockID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if !found {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Block not found."})
		return
	}
	if account.Role != "admin" {
		allowedWorkTypes, err := resolveGrantedWorkTypesForEmail(ctx, tx, account.Email, account.DefaultWorkTypes)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		allowed := false
		for _, wt := range allowedWorkTypes {
			if wt == block.WorkType {
				allowed = true
				break
			}
		}
		if !allowed {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
			return
		}
	}
	// Bug fix: the frontend disables claiming a block once its shift window
	// has passed (WeekGrid's isShiftOver), but that was a client-only rule —
	// nothing stopped a direct API call from reserving hours on a shift that
	// already happened. Enforce the same rule handleCancelBooking and
	// handleUpdateBookingHours apply, here, before any capacity is claimed.
	if deriveShiftBookingStatus(payload.DateKey, block.StartTime, block.EndTime) == "completed" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "This shift has already ended and can no longer be claimed."})
		return
	}
	remainingHours, err := remainingForBlock(ctx, tx, block)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if payload.Hours > remainingHours {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("Only %dh remain in this block.", remainingHours)})
		return
	}
	// enforce per-project daily max: prefer block.MaxHoursPerUser if set,
	// otherwise fall back to the server-side default. payload.MaxHoursPerDay
	// is client-supplied and must never be trusted as the cap itself, or a
	// caller could self-report an inflated limit.
	perUserMax := maxHoursPerDay
	if block.MaxHoursPerUser > 0 {
		perUserMax = block.MaxHoursPerUser
	}
	existingForUser, err := userHoursForDayAndWorkType(ctx, tx, payload.DateKey, payload.UserID, block.WorkType, "")
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if existingForUser+payload.Hours > perUserMax {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("That would put you at %dh of %s today; the max is %dh/day per project.", existingForUser+payload.Hours, block.WorkType, perUserMax)})
		return
	}

	created := Booking{
		UserID:  payload.UserID,
		DateKey: payload.DateKey,
		BlockID: payload.BlockID,
		Hours:   payload.Hours,
	}
	err = tx.QueryRow(ctx, `INSERT INTO bookings (user_id, date_key, block_id, hours) VALUES ($1, $2, $3, $4) RETURNING id`,
		created.UserID, created.DateKey, created.BlockID, created.Hours,
	).Scan(&created.ID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "created": created})
}

func handleUpdateBookingHours(w http.ResponseWriter, r *http.Request) {
	account, ok := requireSessionAccount(w, r)
	if !ok {
		return
	}
	var payload struct {
		BookingID      string `json:"bookingId"`
		Hours          int    `json:"hours"`
		UserID         string `json:"userId"`
		MaxHoursPerDay int    `json:"maxHoursPerDay"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	payload.UserID = account.ID
	ctx := r.Context()
	tx, err := db.Begin(ctx)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	defer tx.Rollback(ctx)

	var target Booking
	err = tx.QueryRow(ctx, `SELECT id, user_id, date_key, block_id, hours FROM bookings WHERE id = $1 FOR UPDATE`, payload.BookingID).
		Scan(&target.ID, &target.UserID, &target.DateKey, &target.BlockID, &target.Hours)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Booking not found."})
		return
	}
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if target.UserID != payload.UserID {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Not your booking."})
		return
	}
	if payload.Hours < 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Hours must be 0 or more."})
		return
	}

	var activeTimerBookingID string
	err = tx.QueryRow(ctx, `SELECT booking_id FROM timers WHERE user_id = $1`, payload.UserID).Scan(&activeTimerBookingID)
	if err != nil && err != pgx.ErrNoRows {
		writeInternalError(w, err)
		return
	}
	if activeTimerBookingID == payload.BookingID {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Stop the timer before changing or cancelling this reservation."})
		return
	}

	var worked float64
	err = tx.QueryRow(ctx, `SELECT hours FROM booking_banked WHERE booking_id = $1`, payload.BookingID).Scan(&worked)
	if err != nil && err != pgx.ErrNoRows {
		writeInternalError(w, err)
		return
	}
	if worked > 0 && float64(payload.Hours) < worked {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("You've already worked %.2fh on this block — it can't be reduced below that.", worked)})
		return
	}

	// Bug fix: this handler is also how the frontend cancels a reservation
	// (by setting Hours to 0) — but unlike handleCancelBooking, it never
	// checked whether the shift's time window had already passed. That let
	// a direct call to update-booking-hours(0) cancel a booking for a shift
	// that already happened, even though the equivalent /cancel-booking
	// request is explicitly blocked below. Look the block up once, up front,
	// and apply the same "shift already happened" rule to every change this
	// endpoint makes, not just the ones that happen to route through
	// /cancel-booking.
	block, _, err := getBlockByID(ctx, tx, target.DateKey, target.BlockID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if payload.Hours != target.Hours && deriveShiftBookingStatus(target.DateKey, block.StartTime, block.EndTime) == "completed" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Can't change a reservation for a shift that already happened."})
		return
	}

	if payload.Hours == 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM bookings WHERE id = $1`, payload.BookingID); err != nil {
			writeInternalError(w, err)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			writeInternalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "cancelled": true, "booking": target})
		return
	}

	var otherBookingsOnBlock int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(hours),0) FROM bookings WHERE date_key=$1 AND block_id=$2 AND id != $3`, target.DateKey, target.BlockID, payload.BookingID).Scan(&otherBookingsOnBlock); err != nil {
		writeInternalError(w, err)
		return
	}
	otherUserHours, err := userHoursForDayAndWorkType(ctx, tx, target.DateKey, payload.UserID, block.WorkType, payload.BookingID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	// respect block-level per-user max if present, otherwise fall back to
	// the server-side default — payload.MaxHoursPerDay is client-supplied
	// and must never be trusted as the cap itself.
	perUserMax := maxHoursPerDay
	if block.MaxHoursPerUser > 0 {
		perUserMax = block.MaxHoursPerUser
	}
	blockCapacityRemaining := int(math.Max(0, float64(block.TotalHours-otherBookingsOnBlock)))
	dailyCapacityRemaining := int(math.Max(0, float64(perUserMax-otherUserHours)))
	maxAllowed := blockCapacityRemaining
	if dailyCapacityRemaining < maxAllowed {
		maxAllowed = dailyCapacityRemaining
	}
	if payload.Hours > maxAllowed {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("Only %dh are available for this booking.", maxAllowed)})
		return
	}
	if payload.Hours == target.Hours {
		if err := tx.Commit(ctx); err != nil {
			writeInternalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updated": false, "booking": target})
		return
	}
	target.Hours = payload.Hours
	if _, err := tx.Exec(ctx, `UPDATE bookings SET hours = $1 WHERE id = $2`, target.Hours, target.ID); err != nil {
		writeInternalError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updated": true, "booking": target})
}

func handleCancelBooking(w http.ResponseWriter, r *http.Request) {
	account, ok := requireSessionAccount(w, r)
	if !ok {
		return
	}
	var payload struct {
		BookingID string `json:"bookingId"`
		UserID    string `json:"userId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	payload.UserID = account.ID
	ctx := r.Context()
	tx, err := db.Begin(ctx)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	defer tx.Rollback(ctx)

	var target Booking
	err = tx.QueryRow(ctx, `SELECT id, user_id, date_key, block_id, hours FROM bookings WHERE id = $1 FOR UPDATE`, payload.BookingID).
		Scan(&target.ID, &target.UserID, &target.DateKey, &target.BlockID, &target.Hours)
	if err == pgx.ErrNoRows {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Booking not found."})
		return
	}
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if target.UserID != payload.UserID {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Not your booking."})
		return
	}
	var activeTimerBookingID string
	err = tx.QueryRow(ctx, `SELECT booking_id FROM timers WHERE user_id = $1`, payload.UserID).Scan(&activeTimerBookingID)
	if err != nil && err != pgx.ErrNoRows {
		writeInternalError(w, err)
		return
	}
	if activeTimerBookingID == payload.BookingID {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Stop the timer before changing or cancelling this reservation."})
		return
	}
	var worked float64
	err = tx.QueryRow(ctx, `SELECT hours FROM booking_banked WHERE booking_id = $1`, payload.BookingID).Scan(&worked)
	if err != nil && err != pgx.ErrNoRows {
		writeInternalError(w, err)
		return
	}
	if worked > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("You've already worked %.2fh on this block — it can't be cancelled.", worked)})
		return
	}
	block, _, err := getBlockByID(ctx, tx, target.DateKey, target.BlockID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if deriveShiftBookingStatus(target.DateKey, block.StartTime, block.EndTime) == "completed" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Can't cancel a shift that already happened."})
		return
	}
	if _, err := tx.Exec(ctx, `DELETE FROM bookings WHERE id = $1`, payload.BookingID); err != nil {
		writeInternalError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GET /api/projects?adminId=xxx returns projects for that admin
func handleGetProjects(w http.ResponseWriter, r *http.Request) {
	account, ok := requireAdminAccount(w, r)
	if !ok {
		return
	}
	rows, err := db.Query(r.Context(), `SELECT name FROM projects WHERE admin_id = $1 ORDER BY id`, account.ID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	defer rows.Close()
	projects := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			writeInternalError(w, err)
			return
		}
		projects = append(projects, name)
	}
	if err := rows.Err(); err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, projects)
}

// POST /api/projects adds a new project for the admin
func handleAddProject(w http.ResponseWriter, r *http.Request) {
	account, ok := requireAdminAccount(w, r)
	if !ok {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid request"})
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "name required"})
		return
	}
	ctx := r.Context()
	tx, err := db.Begin(ctx)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	defer tx.Rollback(ctx)

	// Check if project already exists for this admin. Compared
	// case-insensitively so "hubdoc" and "Hubdoc" are treated as the same
	// project rather than silently creating a duplicate; the existing entry's
	// original casing is kept since blocks already reference that string.
	rows, err := tx.Query(ctx, `SELECT name FROM projects WHERE admin_id = $1 ORDER BY id FOR UPDATE`, account.ID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	projects := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			rows.Close()
			writeInternalError(w, err)
			return
		}
		projects = append(projects, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeInternalError(w, err)
		return
	}
	for _, p := range projects {
		if strings.EqualFold(p, name) {
			writeJSON(w, http.StatusOK, projects)
			return
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO projects (admin_id, name) VALUES ($1, $2)`, account.ID, name); err != nil {
		writeInternalError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, append(projects, name))
}

// handleProjectsRouter dispatches /api/projects: GET lists an admin's
// projects, POST adds a new one. Mirrors the same GET/POST split pattern
// used by handleTimerRouter and handleSessionRouter below.
func handleProjectsRouter(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		handleGetProjects(w, r)
	} else if r.Method == http.MethodPost {
		handleAddProject(w, r)
	} else {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "Method not allowed"})
	}
}

// ---------------------------------------------------------------------------
// Work-type access (extra project grants beyond a user's defaultWorkTypes).
// Mirrors AuthContext.jsx's workTypeAccess: { workType: [emails...] }.
// ---------------------------------------------------------------------------

func getWorkTypeAccessMap(ctx context.Context, q dbtx) (map[string][]string, error) {
	rows, err := q.Query(ctx, `SELECT work_type, email FROM work_type_access ORDER BY work_type, email`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string][]string)
	for rows.Next() {
		var wt, email string
		if err := rows.Scan(&wt, &email); err != nil {
			return nil, err
		}
		out[wt] = append(out[wt], email)
	}
	return out, rows.Err()
}

// GET /api/work-type-access returns the full grant map. Every account (not
// just admins) needs this: non-admin users read it client-side to compute
// their own granted work types (see BoardPage.jsx's grantedWorkTypes), so
// this only requires a valid session, not admin — the bug being fixed is
// "no auth at all", not "should be admin-only".
func handleGetWorkTypeAccess(w http.ResponseWriter, r *http.Request) {
	_, ok := requireSessionAccount(w, r)
	if !ok {
		return
	}
	out, err := getWorkTypeAccessMap(r.Context(), db)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// findWorkTypeKey returns the existing key matching workType case-insensitively,
// or "" if no such key exists yet.
func findWorkTypeKey(ctx context.Context, q dbtx, workType string) (string, error) {
	var key string
	err := q.QueryRow(ctx, `SELECT work_type FROM work_type_access WHERE lower(work_type) = lower($1) LIMIT 1`, workType).Scan(&key)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return key, err
}

// adminOwnsProject reports whether the given admin has added workType to
// their own project list, case-insensitively.
func adminOwnsProject(ctx context.Context, q dbtx, adminID, workType string) (bool, error) {
	var exists bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE admin_id = $1 AND lower(name) = lower($2))`, adminID, workType).Scan(&exists)
	return exists, err
}

// POST /api/work-type-access/grant { email, workType }
func handleGrantWorkTypeAccess(w http.ResponseWriter, r *http.Request) {
	account, ok := requireAdminAccount(w, r)
	if !ok {
		return
	}
	var req struct {
		Email    string `json:"email"`
		WorkType string `json:"workType"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid request"})
		return
	}
	email := normalizeEmail(req.Email)
	workType := strings.TrimSpace(req.WorkType)
	if email == "" || workType == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "email and workType required"})
		return
	}
	ctx := r.Context()
	owns, err := adminOwnsProject(ctx, db, account.ID, workType)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if !owns {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return
	}
	key, err := findWorkTypeKey(ctx, db, workType)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if key == "" {
		key = workType
	}
	if _, err := db.Exec(ctx, `INSERT INTO work_type_access (work_type, email) VALUES ($1, $2) ON CONFLICT (work_type, email) DO NOTHING`, key, email); err != nil {
		writeInternalError(w, err)
		return
	}
	out, err := getWorkTypeAccessMap(ctx, db)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /api/work-type-access/revoke { email, workType }
func handleRevokeWorkTypeAccess(w http.ResponseWriter, r *http.Request) {
	account, ok := requireAdminAccount(w, r)
	if !ok {
		return
	}
	var req struct {
		Email    string `json:"email"`
		WorkType string `json:"workType"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid request"})
		return
	}
	email := normalizeEmail(req.Email)
	workType := strings.TrimSpace(req.WorkType)
	ctx := r.Context()
	owns, err := adminOwnsProject(ctx, db, account.ID, workType)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if !owns {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return
	}
	key, err := findWorkTypeKey(ctx, db, workType)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if key != "" {
		if _, err := db.Exec(ctx, `DELETE FROM work_type_access WHERE work_type = $1 AND email = $2`, key, email); err != nil {
			writeInternalError(w, err)
			return
		}
	}
	out, err := getWorkTypeAccessMap(ctx, db)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Notifications — persistent, per-user in-app notices (see the Notification
// type above for why these are server-side rather than client-only toasts).
// ---------------------------------------------------------------------------

func fetchNotifications(ctx context.Context, q dbtx, userID string) ([]Notification, error) {
	rows, err := q.Query(ctx, `SELECT id, kind, message, created_at, read FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Notification{}
	for rows.Next() {
		var n Notification
		if err := rows.Scan(&n.ID, &n.Kind, &n.Message, &n.CreatedAt, &n.Read); err != nil {
			return nil, err
		}
		list = append(list, n)
	}
	return list, rows.Err()
}

// GET /api/notifications — the caller's own notifications, newest first.
func handleGetNotifications(w http.ResponseWriter, r *http.Request) {
	account, ok := requireSessionAccount(w, r)
	if !ok {
		return
	}
	list, err := fetchNotifications(r.Context(), db, account.ID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// POST /api/notifications/mark-read { id } or { all: true } — scoped to the
// caller's own notifications; a client-supplied userID is never trusted,
// matching every other handler in this file.
func handleMarkNotificationsRead(w http.ResponseWriter, r *http.Request) {
	account, ok := requireSessionAccount(w, r)
	if !ok {
		return
	}
	var payload struct {
		ID  string `json:"id"`
		All bool   `json:"all"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	ctx := r.Context()
	var err error
	if payload.All {
		_, err = db.Exec(ctx, `UPDATE notifications SET read = true WHERE user_id = $1`, account.ID)
	} else {
		_, err = db.Exec(ctx, `UPDATE notifications SET read = true WHERE user_id = $1 AND id = $2`, account.ID, payload.ID)
	}
	if err != nil {
		writeInternalError(w, err)
		return
	}
	list, err := fetchNotifications(ctx, db, account.ID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// ---------------------------------------------------------------------------
// Work timer — one active stopwatch per user, held server-side so refreshing
// the page or opening a second browser/tab reflects the same running timer
// instead of relying on localStorage.
// ---------------------------------------------------------------------------

func getActiveTimer(ctx context.Context, q dbtx, userID string, forUpdate bool) (*Timer, error) {
	query := `SELECT user_id, start_at, task_name, booking_id, block_id, date_key FROM timers WHERE user_id = $1`
	if forUpdate {
		query += " FOR UPDATE"
	}
	var t Timer
	err := q.QueryRow(ctx, query, userID).Scan(&t.UserID, &t.StartAt, &t.TaskName, &t.BookingID, &t.BlockID, &t.DateKey)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// GET /api/timer?userId=xxx returns the user's active timer, or null.
// Also auto-stops (and banks) any timer that's been running implausibly
// long, mirroring the client's previous stale-timer recovery logic.
func handleGetTimer(w http.ResponseWriter, r *http.Request) {
	account, ok := requireSessionAccount(w, r)
	if !ok {
		return
	}
	userID := account.ID
	ctx := r.Context()

	timer, err := getActiveTimer(ctx, db, userID, false)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if timer == nil {
		bankedHours, err := getReportedOverride(ctx, db, userID)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		booking, err := bookingBankedForUser(ctx, db, userID)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"timer": nil, "bankedHours": bankedHours, "bookingBanked": booking})
		return
	}

	elapsedSeconds := float64(time.Now().UnixMilli()-timer.StartAt) / 1000
	if elapsedSeconds > maxPlausibleTimerHours*3600 {
		tx, err := db.Begin(ctx)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		defer tx.Rollback(ctx)

		addedHours, err := bankTimerSeconds(ctx, tx, userID, timer, maxPlausibleTimerHours*3600)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if err := addNotification(ctx, tx, userID, "timer_auto_stopped", fmt.Sprintf(
			"Your timer for %q was stopped automatically after running %dh unattended — %gh was reported.",
			timer.TaskName, maxPlausibleTimerHours, addedHours,
		)); err != nil {
			writeInternalError(w, err)
			return
		}
		bankedHours, err := getReportedOverride(ctx, tx, userID)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		booking, err := bookingBankedForUser(ctx, tx, userID)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			writeInternalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"timer":          nil,
			"bankedHours":    bankedHours,
			"bookingBanked":  booking,
			"autoStopped":    true,
			"autoStoppedFor": addedHours,
		})
		return
	}

	bankedHours, err := getReportedOverride(ctx, db, userID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	booking, err := bookingBankedForUser(ctx, db, userID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"timer": timer, "bankedHours": bankedHours, "bookingBanked": booking})
}

func handleTimerRouter(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		handleGetTimer(w, r)
	} else {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "Method not allowed"})
	}
}

// POST /api/timer/start { userId, taskName, bookingId, blockId, dateKey }
func handleStartTimer(w http.ResponseWriter, r *http.Request) {
	account, ok := requireSessionAccount(w, r)
	if !ok {
		return
	}
	var req struct {
		UserID    string `json:"userId"`
		TaskName  string `json:"taskName"`
		BookingID string `json:"bookingId"`
		BlockID   string `json:"blockId"`
		DateKey   string `json:"dateKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid request"})
		return
	}
	req.UserID = account.ID
	ctx := r.Context()
	tx, err := db.Begin(ctx)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	defer tx.Rollback(ctx)

	// Bug fix: previously this just overwrote any timer already running for
	// this user — e.g. a second tab/device calling start without stopping
	// the first one first. Bank whatever was already accumulated (same
	// accounting handleStopTimer uses) before replacing it, so no worked
	// time is ever lost.
	existing, err := getActiveTimer(ctx, tx, req.UserID, true)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	var previousTimerBanked *float64
	if existing != nil {
		elapsedSeconds := float64(time.Now().UnixMilli()-existing.StartAt) / 1000
		cappedSeconds := math.Min(elapsedSeconds, maxPlausibleTimerHours*3600)
		added, err := bankTimerSeconds(ctx, tx, req.UserID, existing, cappedSeconds)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		previousTimerBanked = &added
	}

	timer := &Timer{
		UserID:    req.UserID,
		StartAt:   time.Now().UnixMilli(),
		TaskName:  req.TaskName,
		BookingID: req.BookingID,
		BlockID:   req.BlockID,
		DateKey:   req.DateKey,
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO timers (user_id, start_at, task_name, booking_id, block_id, date_key)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (user_id) DO UPDATE SET start_at=$2, task_name=$3, booking_id=$4, block_id=$5, date_key=$6
	`, timer.UserID, timer.StartAt, timer.TaskName, timer.BookingID, timer.BlockID, timer.DateKey); err != nil {
		writeInternalError(w, err)
		return
	}

	resp := map[string]any{"ok": true, "timer": timer}
	if previousTimerBanked != nil {
		bankedHours, err := getReportedOverride(ctx, tx, req.UserID)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		booking, err := bookingBankedForUser(ctx, tx, req.UserID)
		if err != nil {
			writeInternalError(w, err)
			return
		}
		resp["previousTimerBanked"] = *previousTimerBanked
		resp["bankedHours"] = bankedHours
		resp["bookingBanked"] = booking
	}
	if err := tx.Commit(ctx); err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// POST /api/timer/stop { userId } — stops the active timer and banks the
// elapsed time into reportedOverride (added to completed-booking hours to
// form the user's effective reported hours).
func handleStopTimer(w http.ResponseWriter, r *http.Request) {
	account, ok := requireSessionAccount(w, r)
	if !ok {
		return
	}
	var req struct {
		UserID               string   `json:"userId"`
		ClientElapsedSeconds *float64 `json:"clientElapsedSeconds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid request"})
		return
	}
	req.UserID = account.ID
	ctx := r.Context()
	tx, err := db.Begin(ctx)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	defer tx.Rollback(ctx)

	timer, err := getActiveTimer(ctx, tx, req.UserID, true)
	if err != nil {
		writeInternalError(w, err)
		return
	}

	var addedHours float64
	if timer != nil {
		elapsedSeconds := float64(time.Now().UnixMilli()-timer.StartAt) / 1000
		// If the client supplies an explicit elapsed-seconds snapshot (e.g.
		// it went offline partway through and is now finalizing the stop),
		// trust whichever is SMALLER — this lets a network outage be
		// excluded from the reported time instead of silently banking the
		// full wall-clock gap, while never letting a client-supplied value
		// inflate the real elapsed.
		if req.ClientElapsedSeconds != nil && *req.ClientElapsedSeconds >= 0 && *req.ClientElapsedSeconds < elapsedSeconds {
			elapsedSeconds = *req.ClientElapsedSeconds
		}
		cappedSeconds := math.Min(elapsedSeconds, maxPlausibleTimerHours*3600)
		addedHours, err = bankTimerSeconds(ctx, tx, req.UserID, timer, cappedSeconds)
		if err != nil {
			writeInternalError(w, err)
			return
		}
	}
	bankedHours, err := getReportedOverride(ctx, tx, req.UserID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	booking, err := bookingBankedForUser(ctx, tx, req.UserID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"addedHours":    addedHours,
		"bankedHours":   bankedHours,
		"bookingBanked": booking,
	})
}

// ---------------------------------------------------------------------------
// Session — mocked Google auth. Login just looks the account up by ID (the
// account list itself still lives client-side in AuthContext.jsx, same as
// before — only *session persistence* moves server-side here) and returns
// the resolved user with grantedWorkTypes computed from workTypeAccess, so a
// page refresh or a second browser/private window can restore "who's logged
// in" from the backend instead of localStorage.
// ---------------------------------------------------------------------------

type sessionAccount struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Email            string   `json:"email"`
	AvatarURL        string   `json:"avatarUrl,omitempty"`
	Role             string   `json:"role"`
	DefaultWorkTypes []string `json:"defaultWorkTypes"`
}

// getSessionAccount looks the session up by ID and joins straight through to
// the user row — no snapshot is stored in the sessions table, so this always
// reflects the account's current state, never a stale copy from login time.
func getSessionAccount(r *http.Request) (*sessionAccount, bool) {
	sessionID := r.Header.Get("X-Session-Id")
	if sessionID == "" {
		sessionID = r.URL.Query().Get("sessionId")
	}
	if sessionID == "" {
		return nil, false
	}
	var account sessionAccount
	err := db.QueryRow(r.Context(), `
		SELECT u.id, u.name, u.email, u.avatar_url, u.role, u.default_work_types
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.id = $1
	`, sessionID).Scan(&account.ID, &account.Name, &account.Email, &account.AvatarURL, &account.Role, &account.DefaultWorkTypes)
	if err != nil {
		return nil, false
	}
	return &account, true
}

func requireSessionAccount(w http.ResponseWriter, r *http.Request) (*sessionAccount, bool) {
	account, ok := getSessionAccount(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return nil, false
	}
	return account, true
}

func requireAdminAccount(w http.ResponseWriter, r *http.Request) (*sessionAccount, bool) {
	account, ok := requireSessionAccount(w, r)
	if !ok {
		return nil, false
	}
	if account.Role != "admin" {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "forbidden"})
		return nil, false
	}
	return account, true
}

func resolveGrantedWorkTypesForEmail(ctx context.Context, q dbtx, email string, defaultWorkTypes []string) ([]string, error) {
	normalizedEmail := normalizeEmail(email)
	granted := map[string]struct{}{}
	for _, wt := range defaultWorkTypes {
		granted[wt] = struct{}{}
	}
	rows, err := q.Query(ctx, `SELECT work_type FROM work_type_access WHERE email = $1`, normalizedEmail)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var wt string
		if err := rows.Scan(&wt); err != nil {
			return nil, err
		}
		granted[wt] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(granted))
	for wt := range granted {
		out = append(out, wt)
	}
	return out, nil
}

// POST /api/register creates a new user.
func handleRegister(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name       string `json:"name"`
		Email      string `json:"email"`
		Password   string `json:"password"`
		Role       string `json:"role"`
		InviteCode string `json:"inviteCode,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid request"})
		return
	}

	name := strings.TrimSpace(req.Name)
	email := normalizeEmail(req.Email)
	password := req.Password
	role := strings.ToLower(strings.TrimSpace(req.Role))
	if role == "" {
		role = "user"
	}
	if name == "" || email == "" || password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "name, email, and password are required"})
		return
	}
	if len(password) < 8 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "password must be at least 8 characters"})
		return
	}
	if role != "user" && role != "admin" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "role must be 'user' or 'admin'"})
		return
	}
	if role == "admin" {
		if defaultAdminInviteCode == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "admin registration is disabled"})
			return
		}
		if req.InviteCode != defaultAdminInviteCode {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid invite code"})
			return
		}
	}

	ctx := r.Context()
	user := User{
		Name:             name,
		Email:            email,
		PasswordHash:     hashPassword(password),
		Role:             role,
		DefaultWorkTypes: []string{},
	}
	err := db.QueryRow(ctx, `
		INSERT INTO users (name, email, password_hash, avatar_url, role, default_work_types)
		VALUES ($1, $2, $3, '', $4, $5)
		RETURNING id
	`, user.Name, user.Email, user.PasswordHash, user.Role, user.DefaultWorkTypes).Scan(&user.ID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation on users.email
			writeJSON(w, http.StatusConflict, map[string]any{"error": "email already registered"})
			return
		}
		writeInternalError(w, err)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"user": map[string]any{
			"id":               user.ID,
			"name":             user.Name,
			"email":            user.Email,
			"avatarUrl":        user.AvatarURL,
			"role":             user.Role,
			"defaultWorkTypes": user.DefaultWorkTypes,
			"grantedWorkTypes": []string{},
		},
	})
}

// POST /api/session/login { email, password } — validates credentials and
// creates a session for the stored user.
func handleSessionLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid request"})
		return
	}

	email := normalizeEmail(req.Email)
	password := req.Password
	if email == "" || password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "email and password are required"})
		return
	}

	ctx := r.Context()
	var user User
	err := db.QueryRow(ctx, `SELECT id, name, email, password_hash, avatar_url, role, default_work_types FROM users WHERE email = $1`, email).
		Scan(&user.ID, &user.Name, &user.Email, &user.PasswordHash, &user.AvatarURL, &user.Role, &user.DefaultWorkTypes)
	if err != nil && err != pgx.ErrNoRows {
		writeInternalError(w, err)
		return
	}
	if err == pgx.ErrNoRows || !passwordMatches(user.PasswordHash, password) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid email or password"})
		return
	}

	account := sessionAccount{
		ID:               user.ID,
		Name:             user.Name,
		Email:            user.Email,
		AvatarURL:        user.AvatarURL,
		Role:             user.Role,
		DefaultWorkTypes: user.DefaultWorkTypes,
	}

	sessionID := fmt.Sprintf("sess-%s-%d", account.ID, time.Now().UnixNano())
	if _, err := db.Exec(ctx, `INSERT INTO sessions (id, user_id) VALUES ($1, $2)`, sessionID, account.ID); err != nil {
		writeInternalError(w, err)
		return
	}

	granted, err := resolveGrantedWorkTypesForEmail(ctx, db, account.Email, account.DefaultWorkTypes)
	if err != nil {
		writeInternalError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"sessionId": sessionID,
		"user": map[string]any{
			"id":               account.ID,
			"name":             account.Name,
			"email":            account.Email,
			"avatarUrl":        account.AvatarURL,
			"role":             account.Role,
			"defaultWorkTypes": account.DefaultWorkTypes,
			"grantedWorkTypes": granted,
		},
	})
}

// GET /api/session?sessionId=xxx restores the session (e.g. on page reload).
func handleSessionGet(w http.ResponseWriter, r *http.Request) {
	account, ok := getSessionAccount(r)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"user": nil})
		return
	}
	granted, err := resolveGrantedWorkTypesForEmail(r.Context(), db, account.Email, account.DefaultWorkTypes)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{
			"id":               account.ID,
			"name":             account.Name,
			"email":            account.Email,
			"avatarUrl":        account.AvatarURL,
			"role":             account.Role,
			"defaultWorkTypes": account.DefaultWorkTypes,
			"grantedWorkTypes": granted,
		},
	})
}

// POST /api/session/logout { sessionId }
func handleSessionLogout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid request"})
		return
	}
	if _, err := db.Exec(r.Context(), `DELETE FROM sessions WHERE id = $1`, req.SessionID); err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleSessionRouter(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		handleSessionGet(w, r)
	} else {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "Method not allowed"})
	}
}

func main() {
	if err := godotenv.Load(); err != nil {
		log.Printf("No .env file loaded: %v", err)
	}
	if envCode := strings.TrimSpace(os.Getenv("ADMIN_INVITE_CODE")); envCode != "" {
		defaultAdminInviteCode = envCode
	}

	ctx := context.Background()
	db = connectDB(ctx)
	defer db.Close()

	authRateLimiter := newRateLimiter(5, time.Minute)

	http.HandleFunc("/api/week-range", withCORS(handleWeekRange))
	http.HandleFunc("/api/week-schedule", withCORS(handleWeekSchedule))
	http.HandleFunc("/api/user-hours", withCORS(handleUserHours))
	http.HandleFunc("/api/user-hours-summary", withCORS(handleUserHoursSummary))
	http.HandleFunc("/api/admin-capacity-summary", withCORS(handleAdminCapacitySummary))
	http.HandleFunc("/api/release-hours", withCORS(handleReleaseHours))
	http.HandleFunc("/api/release-hours-recurring", withCORS(handleReleaseHoursRecurring))
	http.HandleFunc("/api/adjust-released-hours", withCORS(handleAdjustReleasedHours))
	http.HandleFunc("/api/revoke-block", withCORS(handleRevokeBlock))
	http.HandleFunc("/api/reserve-hours", withCORS(handleReserveHours))
	http.HandleFunc("/api/update-booking-hours", withCORS(handleUpdateBookingHours))
	http.HandleFunc("/api/cancel-booking", withCORS(handleCancelBooking))
	http.HandleFunc("/api/projects", withCORS(handleProjectsRouter))
	http.HandleFunc("/api/work-type-access", withCORS(handleGetWorkTypeAccess))
	http.HandleFunc("/api/work-type-access/grant", withCORS(handleGrantWorkTypeAccess))
	http.HandleFunc("/api/work-type-access/revoke", withCORS(handleRevokeWorkTypeAccess))
	http.HandleFunc("/api/notifications", withCORS(handleGetNotifications))
	http.HandleFunc("/api/notifications/mark-read", withCORS(handleMarkNotificationsRead))
	http.HandleFunc("/api/timer", withCORS(handleTimerRouter))
	http.HandleFunc("/api/timer/start", withCORS(handleStartTimer))
	http.HandleFunc("/api/timer/stop", withCORS(handleStopTimer))
	http.HandleFunc("/api/register", withCORS(withRateLimit(handleRegister, authRateLimiter)))
	http.HandleFunc("/api/session", withCORS(handleSessionRouter))
	http.HandleFunc("/api/session/login", withCORS(withRateLimit(handleSessionLogin, authRateLimiter)))
	http.HandleFunc("/api/session/logout", withCORS(handleSessionLogout))

	addr := ":8080"
	log.Printf("Go backend listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

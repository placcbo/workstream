package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

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

type Store struct {
	mu               sync.Mutex
	releaseBlocks    map[string][]Block
	bookings         []Booking
	projects         map[string][]string // Projects per admin: { adminId: [projectNames...] }
	workTypeAccess   map[string][]string // { workType: [normalized emails...] } — extra grants beyond defaultWorkTypes
	timers           map[string]*Timer   // keyed by userID — the user's currently-running timer, if any
	reportedOverride map[string]float64  // keyed by userID — hours banked from stopped timers, on top of completed-booking hours
	nextBlockID      int
	nextBookingID    int
}

var store = &Store{
	releaseBlocks:    make(map[string][]Block),
	bookings:         make([]Booking, 0),
	projects:         make(map[string][]string),
	workTypeAccess:   make(map[string][]string),
	timers:           make(map[string]*Timer),
	reportedOverride: make(map[string]float64),
	nextBlockID:      100,
	nextBookingID:    100,
}

// MaxPlausibleTimerHours mirrors the client-side cap: if a timer has been
// running longer than this (e.g. the tab was closed and reopened days
// later), we don't trust the elapsed time as real tracked work.
const maxPlausibleTimerHours = 12

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
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		fn(w, r)
	}
}

func parseDateKey(value string) (time.Time, error) {
	return time.Parse("2006-01-02", value)
}

func slotEndDateTime(dateKey string, slotIndex int) time.Time {
	base, err := parseDateKey(dateKey)
	if err != nil {
		return time.Time{}
	}
	endHourAbsolute := dayStartHour + slotIndex + 1
	dayOffset := endHourAbsolute / 24
	hourOfDay := endHourAbsolute % 24
	return time.Date(base.Year(), base.Month(), base.Day()+dayOffset, hourOfDay, 0, 0, 0, time.Local)
}

func deriveBookingStatus(dateKey string, slotIndex int) string {
	now := time.Now()
	if slotEndDateTime(dateKey, slotIndex).Before(now) || slotEndDateTime(dateKey, slotIndex).Equal(now) {
		return "completed"
	}
	return "reserved"
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
// Unlike slotEndDateTime, this does NOT depend on a block's TotalHours at
// all — TotalHours is pooled capacity (can be 50, 200, anything) and is
// completely decoupled from how long the actual shift window is. If
// endTime is <= startTime the shift is treated as rolling past midnight
// into the next calendar day.
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

func getBlockBookings(blockID string) []Booking {
	bookings := make([]Booking, 0)
	for _, booking := range store.bookings {
		if booking.BlockID == blockID {
			bookings = append(bookings, booking)
		}
	}
	return bookings
}

func reservedForBlock(blockID string) int {
	sum := 0
	for _, booking := range getBlockBookings(blockID) {
		sum += booking.Hours
	}
	return sum
}

func remainingForBlock(block Block) int {
	return int(math.Max(0, float64(block.TotalHours-reservedForBlock(block.ID))))
}

// normalizeEmail mirrors AuthContext.jsx's normalizeEmail: trim + lowercase
// so grants are matched consistently regardless of how the email was typed.
func normalizeEmail(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func blockWorkType(dateKey, blockID string) string {
	for _, block := range store.releaseBlocks[dateKey] {
		if block.ID == blockID {
			return block.WorkType
		}
	}
	return ""
}

func userHoursForDayAndWorkType(dateKey, userID, workType, excludeBookingID string) int {
	sum := 0
	for _, booking := range store.bookings {
		if booking.DateKey != dateKey || booking.UserID != userID || booking.ID == excludeBookingID {
			continue
		}
		if blockWorkType(dateKey, booking.BlockID) == workType {
			sum += booking.Hours
		}
	}
	return sum
}

func serializeBlock(block Block, currentUserID string) BlockResponse {
	blockBookings := getBlockBookings(block.ID)
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
	}
}

func summarizeDate(dateKey string) Summary {
	blocks := store.releaseBlocks[dateKey]
	releasedHours := 0
	reservedHours := 0
	for _, block := range blocks {
		releasedHours += block.TotalHours
		reservedHours += reservedForBlock(block.ID)
	}
	return Summary{
		ReleasedHours:  releasedHours,
		ReservedHours:  reservedHours,
		RemainingHours: int(math.Max(0, float64(releasedHours-reservedHours))),
	}
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
	var payload struct {
		DateKeys      []string `json:"dateKeys"`
		UserID        string   `json:"userId"`
		IsAdmin       bool     `json:"isAdmin"`
		UserWorkTypes []string `json:"userWorkTypes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}

	response := map[string]struct {
		Blocks  []BlockResponse `json:"blocks"`
		Summary Summary         `json:"summary"`
	}{}

	store.mu.Lock()
	defer store.mu.Unlock()

	for _, dateKey := range payload.DateKeys {
		blocks := make([]BlockResponse, 0)
		for _, block := range store.releaseBlocks[dateKey] {
			serialized := serializeBlock(block, payload.UserID)
			// If caller is admin, only show blocks owned by that admin.
			if payload.IsAdmin {
				if block.OwnerID == payload.UserID {
					blocks = append(blocks, serialized)
				}
				continue
			}
			if payload.UserWorkTypes == nil {
				blocks = append(blocks, serialized)
				continue
			}
			for _, workType := range payload.UserWorkTypes {
				if workType == block.WorkType {
					blocks = append(blocks, serialized)
					break
				}
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
	query := r.URL.Query()
	dateKey := query.Get("dateKey")
	userID := query.Get("userId")
	workType := query.Get("workType")
	result := 0
	store.mu.Lock()
	result = userHoursForDayAndWorkType(dateKey, userID, workType, "")
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, result)
}

func handleUserHoursSummary(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		DateKeys []string `json:"dateKeys"`
		UserID   string   `json:"userId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	dateSet := make(map[string]struct{}, len(payload.DateKeys))
	for _, k := range payload.DateKeys {
		dateSet[k] = struct{}{}
	}
	reportedHours := 0
	reservedHours := 0
	store.mu.Lock()
	for _, booking := range store.bookings {
		if booking.UserID != payload.UserID {
			continue
		}
		if _, ok := dateSet[booking.DateKey]; !ok {
			continue
		}
		block := Block{}
		for _, candidate := range store.releaseBlocks[booking.DateKey] {
			if candidate.ID == booking.BlockID {
				block = candidate
				break
			}
		}
		reservedHours += booking.Hours
		if deriveShiftBookingStatus(booking.DateKey, block.StartTime, block.EndTime) == "completed" {
			reportedHours += booking.Hours
		}
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]int{"reportedHours": reportedHours, "reservedHours": reservedHours})
}

func summarizeDateForOwner(dateKey, ownerID string) Summary {
	blocks := store.releaseBlocks[dateKey]
	releasedHours := 0
	reservedHours := 0
	for _, block := range blocks {
		// When ownerID is provided, only count this admin's own blocks.
		if ownerID != "" && block.OwnerID != ownerID {
			continue
		}
		releasedHours += block.TotalHours
		reservedHours += reservedForBlock(block.ID)
	}
	return Summary{
		ReleasedHours:  releasedHours,
		ReservedHours:  reservedHours,
		RemainingHours: int(math.Max(0, float64(releasedHours-reservedHours))),
	}
}

func handleAdminCapacitySummary(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		DateKeys []string `json:"dateKeys"`
		OwnerID  string   `json:"ownerId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	response := make(map[string]Summary)
	store.mu.Lock()
	for _, dateKey := range payload.DateKeys {
		response[dateKey] = summarizeDateForOwner(dateKey, payload.OwnerID)
	}
	store.mu.Unlock()
	writeJSON(w, http.StatusOK, response)
}

func handleReleaseHours(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		DateKey         string `json:"dateKey"`
		TotalHours      int    `json:"totalHours"`
		BlockSize       int    `json:"blockSize"`
		StartSlot       int    `json:"startSlot"`
		ShiftName       string `json:"shiftName"`
		StartTime       string `json:"startTime"`
		EndTime         string `json:"endTime"`
		WorkType        string `json:"workType"`
		OwnerID         string `json:"ownerId"`
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
	created := addRelease(payload.DateKey, payload.TotalHours, payload.BlockSize, payload.StartSlot, payload.ShiftName, payload.StartTime, payload.EndTime, payload.WorkType, payload.OwnerID, payload.MaxHoursPerUser)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "created": created})
}

func addRelease(dateKey string, totalHours, blockSize, startSlot int, shiftName, startTime, endTime, workType, ownerId string, maxHoursPerUser int) []Block {
	store.mu.Lock()
	defer store.mu.Unlock()
	current := store.releaseBlocks[dateKey]
	blocks := buildBlocks(totalHours, blockSize, startSlot)
	created := make([]Block, 0, len(blocks))
	for _, block := range blocks {
		store.nextBlockID++
		block.ID = fmt.Sprintf("rb-%d", store.nextBlockID)
		block.DateKey = dateKey
		block.ShiftName = shiftName
		block.StartTime = startTime
		block.EndTime = endTime
		block.WorkType = workType
		block.OwnerID = ownerId
		if maxHoursPerUser > 0 {
			block.MaxHoursPerUser = maxHoursPerUser
		}
		created = append(created, block)
	}
	store.releaseBlocks[dateKey] = append(current, created...)
	return created
}

func handleAdjustReleasedHours(w http.ResponseWriter, r *http.Request) {
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
	store.mu.Lock()
	defer store.mu.Unlock()
	current := store.releaseBlocks[payload.DateKey]
	var updatedBlock *Block
	reserved := 0
	for i, block := range current {
		if block.ID != payload.BlockID {
			continue
		}
		reserved = reservedForBlock(block.ID)
		normalizedTotal := payload.TotalHours
		if normalizedTotal < 1 {
			normalizedTotal = 1
		}
		if normalizedTotal < reserved {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("Can't reduce below %dh — that's already claimed on this block.", reserved)})
			return
		}
		// Bug fix: changing a block's workType after users have already
		// claimed hours on it silently orphans their bookings —
		// handleWeekSchedule filters blocks by the project(s) a user has
		// been granted, so a claimant without access to the NEW workType
		// would stop seeing a block they still have hours reserved on,
		// while those hours still count against their day in
		// handleUserHoursSummary. Reassigning the project is only safe
		// once nobody has claimed anything from this block yet.
		trimmedWorkType := strings.TrimSpace(payload.WorkType)
		if trimmedWorkType != "" && trimmedWorkType != block.WorkType && reserved > 0 {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("Can't change the project — %dh are already claimed on this block under %q.", reserved, block.WorkType)})
			return
		}
		current[i].TotalHours = normalizedTotal
		current[i].BlockSize = normalizedTotal
		if payload.ShiftName != "" {
			current[i].ShiftName = payload.ShiftName
		}
		if payload.StartTime != "" {
			current[i].StartTime = payload.StartTime
		}
		if payload.EndTime != "" {
			current[i].EndTime = payload.EndTime
		}
		if payload.WorkType != "" {
			current[i].WorkType = payload.WorkType
		}
		if payload.MaxHoursPerUser > 0 {
			current[i].MaxHoursPerUser = payload.MaxHoursPerUser
		}
		updatedBlock = &current[i]
		break
	}
	store.releaseBlocks[payload.DateKey] = current
	if updatedBlock == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Block not found."})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updated": updatedBlock})
}

func handleRevokeBlock(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		DateKey string `json:"dateKey"`
		BlockID string `json:"blockId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if reservedForBlock(payload.BlockID) > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "This block already has reservations."})
		return
	}
	current := store.releaseBlocks[payload.DateKey]
	next := make([]Block, 0, len(current))
	for _, block := range current {
		if block.ID == payload.BlockID {
			continue
		}
		next = append(next, block)
	}
	store.releaseBlocks[payload.DateKey] = next
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func handleReserveHours(w http.ResponseWriter, r *http.Request) {
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
	if payload.Hours < 1 {
		payload.Hours = 1
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	block := Block{}
	for _, candidate := range store.releaseBlocks[payload.DateKey] {
		if candidate.ID == payload.BlockID {
			block = candidate
			break
		}
	}
	if block.ID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Block not found."})
		return
	}
	remainingHours := remainingForBlock(block)
	if payload.Hours > remainingHours {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("Only %dh remain in this block.", remainingHours)})
		return
	}
	// enforce per-project daily max: prefer block.MaxHoursPerUser if set, otherwise use payload.MaxHoursPerDay
	perUserMax := payload.MaxHoursPerDay
	if block.MaxHoursPerUser > 0 {
		perUserMax = block.MaxHoursPerUser
	}
	existingForUser := userHoursForDayAndWorkType(payload.DateKey, payload.UserID, block.WorkType, "")
	if existingForUser+payload.Hours > perUserMax {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("That would put you at %dh of %s today; the max is %dh/day per project.", existingForUser+payload.Hours, block.WorkType, perUserMax)})
		return
	}
	store.nextBookingID++
	created := Booking{
		ID:      fmt.Sprintf("b-%d", store.nextBookingID),
		UserID:  payload.UserID,
		DateKey: payload.DateKey,
		BlockID: payload.BlockID,
		Hours:   payload.Hours,
	}
	store.bookings = append(store.bookings, created)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "created": created})
}

func handleUpdateBookingHours(w http.ResponseWriter, r *http.Request) {
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
	store.mu.Lock()
	defer store.mu.Unlock()
	var target *Booking
	for i := range store.bookings {
		if store.bookings[i].ID == payload.BookingID {
			target = &store.bookings[i]
			break
		}
	}
	if target == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Booking not found."})
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
	if payload.Hours == 0 {
		original := *target
		next := make([]Booking, 0, len(store.bookings)-1)
		for _, booking := range store.bookings {
			if booking.ID == payload.BookingID {
				continue
			}
			next = append(next, booking)
		}
		store.bookings = next
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "cancelled": true, "booking": original})
		return
	}
	block := Block{}
	for _, candidate := range store.releaseBlocks[target.DateKey] {
		if candidate.ID == target.BlockID {
			block = candidate
			break
		}
	}
	otherBookingsOnBlock := 0
	for _, booking := range store.bookings {
		if booking.DateKey == target.DateKey && booking.BlockID == target.BlockID && booking.ID != payload.BookingID {
			otherBookingsOnBlock += booking.Hours
		}
	}
	otherUserHours := userHoursForDayAndWorkType(target.DateKey, payload.UserID, block.WorkType, payload.BookingID)
	// respect block-level per-user max if present
	perUserMax := payload.MaxHoursPerDay
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
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updated": false, "booking": *target})
		return
	}
	target.Hours = payload.Hours
	updated := *target
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updated": true, "booking": updated})
}

func handleCancelBooking(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		BookingID string `json:"bookingId"`
		UserID    string `json:"userId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	idx := -1
	for i, booking := range store.bookings {
		if booking.ID == payload.BookingID {
			idx = i
			break
		}
	}
	if idx == -1 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Booking not found."})
		return
	}
	target := store.bookings[idx]
	if target.UserID != payload.UserID {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Not your booking."})
		return
	}
	block := Block{}
	for _, candidate := range store.releaseBlocks[target.DateKey] {
		if candidate.ID == target.BlockID {
			block = candidate
			break
		}
	}
	if deriveShiftBookingStatus(target.DateKey, block.StartTime, block.EndTime) == "completed" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Can't cancel a shift that already happened."})
		return
	}
	store.bookings = append(store.bookings[:idx], store.bookings[idx+1:]...)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GET /api/projects?adminId=xxx returns projects for that admin
func handleGetProjects(w http.ResponseWriter, r *http.Request) {
	adminId := r.URL.Query().Get("adminId")
	if adminId == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "adminId required"})
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	projects := store.projects[adminId]
	if projects == nil {
		projects = []string{}
	}
	writeJSON(w, http.StatusOK, projects)
}

// POST /api/projects adds a new project for the admin
func handleAddProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AdminId string `json:"adminId"`
		Name    string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid request"})
		return
	}
	name := strings.TrimSpace(req.Name)
	if req.AdminId == "" || name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "adminId and name required"})
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	// Check if project already exists for this admin. Compared
	// case-insensitively so "hubdoc" and "Hubdoc" are treated as the same
	// project rather than silently creating a duplicate; the existing entry's
	// original casing is kept since blocks already reference that string.
	projects := store.projects[req.AdminId]
	for _, p := range projects {
		if strings.EqualFold(p, name) {
			writeJSON(w, http.StatusOK, projects)
			return
		}
	}
	store.projects[req.AdminId] = append(projects, name)
	writeJSON(w, http.StatusOK, store.projects[req.AdminId])
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

// GET /api/work-type-access returns the full grant map.
func handleGetWorkTypeAccess(w http.ResponseWriter, r *http.Request) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := make(map[string][]string, len(store.workTypeAccess))
	for k, v := range store.workTypeAccess {
		out[k] = append([]string{}, v...)
	}
	writeJSON(w, http.StatusOK, out)
}

// findWorkTypeKey returns the existing key matching workType case-insensitively,
// or "" if no such key exists yet. Callers must hold store.mu.
func findWorkTypeKey(workType string) string {
	for key := range store.workTypeAccess {
		if strings.EqualFold(key, workType) {
			return key
		}
	}
	return ""
}

// POST /api/work-type-access/grant { email, workType }
func handleGrantWorkTypeAccess(w http.ResponseWriter, r *http.Request) {
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
	store.mu.Lock()
	defer store.mu.Unlock()
	key := findWorkTypeKey(workType)
	if key == "" {
		key = workType
	}
	existing := store.workTypeAccess[key]
	already := false
	for _, e := range existing {
		if e == email {
			already = true
			break
		}
	}
	if !already {
		store.workTypeAccess[key] = append(existing, email)
	}
	out := make(map[string][]string, len(store.workTypeAccess))
	for k, v := range store.workTypeAccess {
		out[k] = append([]string{}, v...)
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /api/work-type-access/revoke { email, workType }
func handleRevokeWorkTypeAccess(w http.ResponseWriter, r *http.Request) {
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
	store.mu.Lock()
	defer store.mu.Unlock()
	key := findWorkTypeKey(workType)
	if key != "" {
		existing := store.workTypeAccess[key]
		next := make([]string, 0, len(existing))
		for _, e := range existing {
			if e != email {
				next = append(next, e)
			}
		}
		store.workTypeAccess[key] = next
	}
	out := make(map[string][]string, len(store.workTypeAccess))
	for k, v := range store.workTypeAccess {
		out[k] = append([]string{}, v...)
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Work timer — one active stopwatch per user, held server-side so refreshing
// the page or opening a second browser/tab reflects the same running timer
// instead of relying on localStorage.
// ---------------------------------------------------------------------------

// GET /api/timer?userId=xxx returns the user's active timer, or null.
// Also auto-stops (and banks) any timer that's been running implausibly
// long, mirroring the client's previous stale-timer recovery logic.
func handleGetTimer(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("userId")
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "userId required"})
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	timer := store.timers[userID]
	if timer == nil {
		writeJSON(w, http.StatusOK, map[string]any{"timer": nil, "bankedHours": store.reportedOverride[userID]})
		return
	}
	elapsedSeconds := float64(time.Now().UnixMilli()-timer.StartAt) / 1000
	if elapsedSeconds > maxPlausibleTimerHours*3600 {
		addedHours := math.Round(maxPlausibleTimerHours*10) / 10
		// Bug fix: only bank timer hours for ad-hoc tracking (no BookingID).
		// A timer tied to a specific booking tracks time against a shift
		// whose FULL reserved hours already get counted in
		// handleUserHoursSummary once that shift's real end time passes
		// (deriveShiftBookingStatus). Banking the timer's elapsed hours on
		// top of that double-counts the same shift once it naturally
		// completes — this only mattered as a workaround back when
		// completion was derived from totalHours and effectively never
		// fired on its own.
		if timer.BookingID == "" {
			store.reportedOverride[userID] += addedHours
		}
		delete(store.timers, userID)
		writeJSON(w, http.StatusOK, map[string]any{
			"timer":          nil,
			"bankedHours":    store.reportedOverride[userID],
			"autoStopped":    true,
			"autoStoppedFor": addedHours,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"timer": timer, "bankedHours": store.reportedOverride[userID]})
}

// POST /api/timer/start { userId, taskName, bookingId, blockId, dateKey }
func handleStartTimer(w http.ResponseWriter, r *http.Request) {
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
	if req.UserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "userId required"})
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	timer := &Timer{
		UserID:    req.UserID,
		StartAt:   time.Now().UnixMilli(),
		TaskName:  req.TaskName,
		BookingID: req.BookingID,
		BlockID:   req.BlockID,
		DateKey:   req.DateKey,
	}
	store.timers[req.UserID] = timer
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "timer": timer})
}

// POST /api/timer/stop { userId } — stops the active timer and banks the
// elapsed time into reportedOverride (added to completed-booking hours to
// form the user's effective reported hours).
func handleStopTimer(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UserID string `json:"userId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid request"})
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	timer := store.timers[req.UserID]
	if timer == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "addedHours": 0.0, "bankedHours": store.reportedOverride[req.UserID]})
		return
	}
	elapsedSeconds := float64(time.Now().UnixMilli()-timer.StartAt) / 1000
	cappedSeconds := math.Min(elapsedSeconds, maxPlausibleTimerHours*3600)
	addedHours := math.Round((cappedSeconds/3600)*10) / 10
	// Bug fix: see handleGetTimer for the same reasoning — only bank
	// elapsed hours for timers not tied to a specific booking, so a
	// completed shift's reserved hours don't get counted twice (once via
	// the timer-banked override, once via the booking itself completing).
	if timer.BookingID == "" {
		store.reportedOverride[req.UserID] += addedHours
	}
	delete(store.timers, req.UserID)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"addedHours":  addedHours,
		"bankedHours": store.reportedOverride[req.UserID],
	})
}

func handleTimerRouter(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		handleGetTimer(w, r)
	} else {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "Method not allowed"})
	}
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

// activeSessions maps a sessionId -> account, so the frontend can hold a
// random session token instead of caching the whole user object itself.
var activeSessions = struct {
	mu sync.Mutex
	m  map[string]sessionAccount
}{m: make(map[string]sessionAccount)}

func resolveGrantedWorkTypesForEmail(email string, defaultWorkTypes []string) []string {
	normalizedEmail := normalizeEmail(email)
	granted := map[string]struct{}{}
	for _, wt := range defaultWorkTypes {
		granted[wt] = struct{}{}
	}
	for workType, emails := range store.workTypeAccess {
		for _, e := range emails {
			if e == normalizedEmail {
				granted[workType] = struct{}{}
				break
			}
		}
	}
	out := make([]string, 0, len(granted))
	for wt := range granted {
		out = append(out, wt)
	}
	return out
}

// POST /api/session/login { account: sessionAccount } — stores the session
// server-side and returns a sessionId plus the resolved user (with
// grantedWorkTypes filled in). The frontend persists only the sessionId.
func handleSessionLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Account sessionAccount `json:"account"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid request"})
		return
	}
	if req.Account.ID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "account.id required"})
		return
	}
	sessionID := fmt.Sprintf("sess-%s-%d", req.Account.ID, time.Now().UnixNano())
	activeSessions.mu.Lock()
	activeSessions.m[sessionID] = req.Account
	activeSessions.mu.Unlock()

	store.mu.Lock()
	granted := resolveGrantedWorkTypesForEmail(req.Account.Email, req.Account.DefaultWorkTypes)
	store.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"sessionId": sessionID,
		"user": map[string]any{
			"id":               req.Account.ID,
			"name":             req.Account.Name,
			"email":            req.Account.Email,
			"avatarUrl":        req.Account.AvatarURL,
			"role":             req.Account.Role,
			"defaultWorkTypes": req.Account.DefaultWorkTypes,
			"grantedWorkTypes": granted,
		},
	})
}

// GET /api/session?sessionId=xxx restores the session (e.g. on page reload).
func handleSessionGet(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("sessionId")
	activeSessions.mu.Lock()
	account, ok := activeSessions.m[sessionID]
	activeSessions.mu.Unlock()
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"user": nil})
		return
	}
	store.mu.Lock()
	granted := resolveGrantedWorkTypesForEmail(account.Email, account.DefaultWorkTypes)
	store.mu.Unlock()
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
	activeSessions.mu.Lock()
	delete(activeSessions.m, req.SessionID)
	activeSessions.mu.Unlock()
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
	http.HandleFunc("/api/week-range", withCORS(handleWeekRange))
	http.HandleFunc("/api/week-schedule", withCORS(handleWeekSchedule))
	http.HandleFunc("/api/user-hours", withCORS(handleUserHours))
	http.HandleFunc("/api/user-hours-summary", withCORS(handleUserHoursSummary))
	http.HandleFunc("/api/admin-capacity-summary", withCORS(handleAdminCapacitySummary))
	http.HandleFunc("/api/release-hours", withCORS(handleReleaseHours))
	http.HandleFunc("/api/adjust-released-hours", withCORS(handleAdjustReleasedHours))
	http.HandleFunc("/api/revoke-block", withCORS(handleRevokeBlock))
	http.HandleFunc("/api/reserve-hours", withCORS(handleReserveHours))
	http.HandleFunc("/api/update-booking-hours", withCORS(handleUpdateBookingHours))
	http.HandleFunc("/api/cancel-booking", withCORS(handleCancelBooking))
	http.HandleFunc("/api/projects", withCORS(handleProjectsRouter))
	http.HandleFunc("/api/work-type-access", withCORS(handleGetWorkTypeAccess))
	http.HandleFunc("/api/work-type-access/grant", withCORS(handleGrantWorkTypeAccess))
	http.HandleFunc("/api/work-type-access/revoke", withCORS(handleRevokeWorkTypeAccess))
	http.HandleFunc("/api/timer", withCORS(handleTimerRouter))
	http.HandleFunc("/api/timer/start", withCORS(handleStartTimer))
	http.HandleFunc("/api/timer/stop", withCORS(handleStopTimer))
	http.HandleFunc("/api/session", withCORS(handleSessionRouter))
	http.HandleFunc("/api/session/login", withCORS(handleSessionLogin))
	http.HandleFunc("/api/session/logout", withCORS(handleSessionLogout))

	addr := ":8080"
	log.Printf("Go backend listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
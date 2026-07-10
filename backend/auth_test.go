package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/joho/godotenv"
)

func TestMain(m *testing.M) {
	_ = godotenv.Load()
	db = connectDB(context.Background())
	defer db.Close()
	os.Exit(m.Run())
}

// truncateAll resets every table between tests, including sequences, so
// tests are deterministic and independent of run order — the direct
// Postgres equivalent of reassigning a fresh in-memory Store, which this
// used to do before persistence moved to Postgres.
//
// RESTART IDENTITY only resets sequences owned by a column (SERIAL /
// GENERATED ... AS IDENTITY) — projects/work_type_access use BIGSERIAL so
// that part's covered, but user_id_seq/release_block_id_seq/booking_id_seq/
// notification_id_seq are standalone sequences referenced from a DEFAULT
// expression, so TRUNCATE never touches them. Reset those explicitly.
func truncateAll(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	_, err := db.Exec(ctx, `
		TRUNCATE TABLE
			notifications, booking_banked, reported_override, timers,
			bookings, release_blocks, work_type_access, projects,
			sessions, users
		RESTART IDENTITY CASCADE
	`)
	if err != nil {
		t.Fatalf("failed to truncate tables: %v", err)
	}
	_, err = db.Exec(ctx, `
		ALTER SEQUENCE user_id_seq RESTART WITH 1;
		ALTER SEQUENCE release_block_id_seq RESTART WITH 100;
		ALTER SEQUENCE booking_id_seq RESTART WITH 100;
		ALTER SEQUENCE notification_id_seq RESTART WITH 1;
	`)
	if err != nil {
		t.Fatalf("failed to reset sequences: %v", err)
	}
}

func TestRegisterAndLoginFlow(t *testing.T) {
	truncateAll(t)

	defaultAdminInviteCode = "test-admin-invite"
	registerReq := map[string]any{
		"name":       "Test Admin",
		"email":      "admin@example.com",
		"password":   "secret123",
		"role":       "admin",
		"inviteCode": defaultAdminInviteCode,
	}
	body, _ := json.Marshal(registerReq)
	req := httptest.NewRequest("POST", "/api/register", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	handleRegister(rec, req)
	if rec.Code != 201 {
		t.Fatalf("expected 201, got %d", rec.Code)
	}

	loginReq := map[string]any{"email": "admin@example.com", "password": "secret123"}
	body, _ = json.Marshal(loginReq)
	req = httptest.NewRequest("POST", "/api/session/login", bytes.NewReader(body))
	rec = httptest.NewRecorder()

	handleSessionLogin(rec, req)
	if rec.Code != 200 {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	var out struct {
		User map[string]any `json:"user"`
	}
	if err := json.NewDecoder(io.Reader(bytes.NewReader(rec.Body.Bytes()))).Decode(&out); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if out.User["role"] != "admin" {
		t.Fatalf("expected admin role, got %v", out.User["role"])
	}
}

func TestRegisterRejectsShortPassword(t *testing.T) {
	truncateAll(t)

	registerReq := map[string]any{
		"name":       "Short Password",
		"email":      "short@example.com",
		"password":   "1234567",
		"role":       "user",
		"inviteCode": "",
	}
	body, _ := json.Marshal(registerReq)
	req := httptest.NewRequest("POST", "/api/register", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	handleRegister(rec, req)

	if rec.Code != 400 {
		t.Fatalf("expected 400 for short password, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSessionLoginRejectsClientSuppliedAccount(t *testing.T) {
	truncateAll(t)

	defaultAdminInviteCode = "test-admin-invite"
	registerReq := map[string]any{
		"name":       "Test User",
		"email":      "bypass@example.com",
		"password":   "secret123",
		"role":       "user",
		"inviteCode": "",
	}
	body, _ := json.Marshal(registerReq)
	req := httptest.NewRequest("POST", "/api/register", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	handleRegister(rec, req)
	if rec.Code != 201 {
		t.Fatalf("expected 201 registering user, got %d", rec.Code)
	}

	loginReq := map[string]any{
		"account": map[string]any{
			"id":    "user-1",
			"email": "bypass@example.com",
			"role":  "user",
		},
	}
	body, _ = json.Marshal(loginReq)
	req = httptest.NewRequest("POST", "/api/session/login", bytes.NewReader(body))
	rec = httptest.NewRecorder()

	handleSessionLogin(rec, req)
	if rec.Code != 400 {
		t.Fatalf("expected 400 for client-supplied account bypass, got %d body=%s", rec.Code, rec.Body.String())
	}
}

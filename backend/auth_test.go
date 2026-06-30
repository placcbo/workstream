package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestRegisterAndLoginFlow(t *testing.T) {
	store = &Store{
		releaseBlocks:    make(map[string][]Block),
		projects:         make(map[string][]string),
		workTypeAccess:   make(map[string][]string),
		users:            make(map[string]User),
		timers:           make(map[string]*Timer),
		reportedOverride: make(map[string]float64),
		bookingBanked:    make(map[string]float64),
		nextBlockID:      100,
		nextBookingID:    100,
		nextUserID:       1,
	}
	activeSessions = struct {
		mu sync.Mutex
		m  map[string]sessionAccount
	}{m: make(map[string]sessionAccount)}

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

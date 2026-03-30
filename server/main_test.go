package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"priv-signal/internal"
	"github.com/gorilla/websocket"
)

func TestHandleConnection(t *testing.T) {
	hub := internal.NewHub()

	// Use our actual handler logic from main
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleConnection(w, r, hub)
	})
	server := httptest.NewServer(handler)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	// Test establishing a websocket connection successfully
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to dial websocket: %v", err)
	}
	defer conn.Close()

	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Errorf("Expected status code 101 Switching Protocols, got %d", resp.StatusCode)
	}

	// Make sure connection stays alive and we can format a join message
	joinMsg := []byte(`{"v": 1, "type": "join", "room": "main-room"}`)
	if err := conn.WriteMessage(websocket.TextMessage, joinMsg); err != nil {
		t.Fatalf("Failed to write test message: %v", err)
	}

	// Read proper response (validating that internal Hub indeed processed this)
	_, responseMsg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("Failed to read response: %v", err)
	}

	if !strings.Contains(string(responseMsg), `"type":"join"`) {
		t.Errorf("Expected join response, got %s", string(responseMsg))
	}
}

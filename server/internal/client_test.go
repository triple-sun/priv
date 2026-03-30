package internal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestClient_ReadPumpAndWritePump(t *testing.T) {
	hub := NewHub()

	// Setup a test server to handle the websocket connection
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("Failed to upgrade websocket: %v", err)
		}
		
		client := &Client{
			Conn: conn,
			Send: make(chan []byte, 256),
		}
		
		// Run pumps in goroutines
		go client.WritePump()
		go client.ReadPump(hub)

		// Test WritePump by sending a message directly to the client's output channel
		msg := Envelope{Version: 1, Type: TypeJoin, Room: "forced-test"}
		b, _ := json.Marshal(msg)
		client.Send <- b
	})

	server := httptest.NewServer(handler)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	// Connect to the test server
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to dial websocket: %v", err)
	}
	defer conn.Close()

	// The client should immediately receive the message pushed via the WritePump
	var response Envelope
	err = conn.ReadJSON(&response)
	if err != nil {
		t.Fatalf("Failed to read JSON from WritePump: %v", err)
	}

	if response.Room != "forced-test" {
		t.Errorf("Expected room forced-test, got %s", response.Room)
	}

	// Test ReadPump by sending an invalid message, resulting in an Error envelope
	err = conn.WriteMessage(websocket.TextMessage, []byte("invalid-json"))
	if err != nil {
		t.Fatalf("Failed to write to client: %v", err)
	}

	// Expect an error response routed through hub's RouteMessage back to the client
	var errResponse Envelope
	err = conn.ReadJSON(&errResponse)
	if err != nil {
		t.Fatalf("Failed to read error JSON: %v", err)
	}

	if errResponse.Type != TypeError {
		t.Errorf("Expected response type %s for invalid JSON, got %s", TypeError, errResponse.Type)
	}
}

package internal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// setupTestServer creates a hub, an httptest server, and returns them along with the server URL
func setupTestServer(t *testing.T) (*Hub, *httptest.Server, string) {
	hub := NewHub()
	
	// Set up a simple HTTP handler that upgrades the connection, similar to what main.go will do
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("Failed to upgrade websocket: %v", err)
		}
		
		client := &Client{Conn: conn, Send: make(chan []byte, 256)}
		go client.WritePump()
		go client.ReadPump(hub)
	})

	server := httptest.NewServer(handler)
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	return hub, server, wsURL
}

// connectClient is a helper to establish a websocket connection to the test server
func connectClient(t *testing.T, wsURL string) *websocket.Conn {
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to dial websocket: %v", err)
	}
	return conn
}


func TestHub_JoinCreatesRoomAndReturnsToken(t *testing.T) {
	_, server, wsURL := setupTestServer(t)
	defer server.Close()

	conn := connectClient(t, wsURL)
	defer conn.Close()

	// Send join message
	joinMsg := Envelope{Version: 1, Type: TypeJoin, Room: "test-room"}
	err := conn.WriteJSON(joinMsg)
	if err != nil {
		t.Fatalf("Failed to write JSON: %v", err)
	}

	// Read response
	var response Envelope
	err = conn.ReadJSON(&response)
	if err != nil {
		t.Fatalf("Failed to read JSON: %v", err)
	}

	if response.Type != TypeJoin {
		t.Errorf("Expected response type %s, got %s", TypeJoin, response.Type)
	}

	// Extract the generated token
	var payload map[string]string
	json.Unmarshal(response.Payload, &payload)
	if payload["token"] == "" {
		t.Error("Expected a token in the payload, got none")
	}
}

func TestHub_MessageForwarding(t *testing.T) {
	_, server, wsURL := setupTestServer(t)
	defer server.Close()

	// 1. First client connects and joins a room
	conn1 := connectClient(t, wsURL)
	defer conn1.Close()

	conn1.WriteJSON(Envelope{Version: 1, Type: TypeJoin, Room: "test-room"})
	
	var joinResp Envelope
	conn1.ReadJSON(&joinResp)
	
	var payload map[string]string
	json.Unmarshal(joinResp.Payload, &payload)
	token := payload["token"]

	// 2. Second client joins with the token
	conn2 := connectClient(t, wsURL)
	defer conn2.Close()
	
	err := conn2.WriteJSON(Envelope{Version: 1, Type: TypeJoin, Room: "test-room", Token: token})
	if err != nil {
		t.Fatalf("Client 2 failed to write JSON: %v", err)
	}

	// Wait briefly for Client 2 to be registered in the Hub
	time.Sleep(100 * time.Millisecond)

	// 3. Client 1 sends an offer
	offerPayload := []byte(`{"sdp": "dummy"}`)
	err = conn1.WriteJSON(Envelope{Version: 1, Type: TypeOffer, Room: "test-room", Payload: json.RawMessage(offerPayload)})
	if err != nil {
		t.Fatalf("Client 1 failed to send offer: %v", err)
	}

	// 4. Client 2 should receive the offer
	var offerResp Envelope
	err = conn2.ReadJSON(&offerResp)
	if err != nil {
		t.Fatalf("Client 2 failed to read JSON: %v", err)
	}

	if offerResp.Type != TypeOffer {
		t.Errorf("Expected TypeOffer, got %s", offerResp.Type)
	}
}
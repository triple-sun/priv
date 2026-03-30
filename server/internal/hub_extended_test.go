package internal

import (
	"encoding/json"
	"testing"
)

func TestHub_CapacityAndTokenErrors(t *testing.T) {
	_, server, wsURL := setupTestServer(t)
	defer server.Close()

	// --- 1. Client 1 joins ---
	conn1 := connectClient(t, wsURL)
	defer conn1.Close()

	_ = conn1.WriteJSON(Envelope{Version: 1, Type: TypeJoin, Room: "capped-room"})
	
	var joinResp1 Envelope
	_ = conn1.ReadJSON(&joinResp1)
	
	var payload map[string]string
	_ = json.Unmarshal(joinResp1.Payload, &payload)
	token := payload["token"]

	// --- 2. Client connecting with WRONG token ---
	connWrongToken := connectClient(t, wsURL)
	defer connWrongToken.Close()

	_ = connWrongToken.WriteJSON(Envelope{Version: 1, Type: TypeJoin, Room: "capped-room", Token: "bad-token"})
	
	var errResp Envelope
	_ = connWrongToken.ReadJSON(&errResp)
	if errResp.Type != TypeError {
		t.Errorf("Expected TypeError for wrong token, got %v", errResp.Type)
	}

	// --- 3. Client 2 joins (fills room) ---
	conn2 := connectClient(t, wsURL)
	defer conn2.Close()
	
	_ = conn2.WriteJSON(Envelope{Version: 1, Type: TypeJoin, Room: "capped-room", Token: token})
	_ = conn2.ReadJSON(&Envelope{}) // consume join conf

	// --- 4. Client 3 attempts to join (room full) ---
	conn3 := connectClient(t, wsURL)
	defer conn3.Close()
	
	_ = conn3.WriteJSON(Envelope{Version: 1, Type: TypeJoin, Room: "capped-room", Token: token})
	
	var fullResp Envelope
	_ = conn3.ReadJSON(&fullResp)
	if fullResp.Type != TypeError {
		t.Errorf("Expected TypeError for full room, got %v", fullResp.Type)
	}
}

func TestHub_RemoveClient(t *testing.T) {
	_, server, wsURL := setupTestServer(t)
	defer server.Close()

	conn1 := connectClient(t, wsURL)
	_ = conn1.WriteJSON(Envelope{Version: 1, Type: TypeJoin, Room: "leave-room"})
	var joinResp1 Envelope
	_ = conn1.ReadJSON(&joinResp1)
	
	var payload map[string]string
	_ = json.Unmarshal(joinResp1.Payload, &payload)
	token := payload["token"]

	conn2 := connectClient(t, wsURL)
	defer conn2.Close()
	_ = conn2.WriteJSON(Envelope{Version: 1, Type: TypeJoin, Room: "leave-room", Token: token})
	_ = conn2.ReadJSON(&Envelope{}) // consume join conf

	// Conn1 closes, should trigger RemoveClient and empty the room from conn1 perspective, 
	// and notify conn2
	conn1.Close()

	var leaveEnv Envelope
	err := conn2.ReadJSON(&leaveEnv)
	if err != nil {
		t.Fatalf("Failed to read after conn1 closed: %v", err)
	}
	
	if leaveEnv.Type != TypeLeave {
		t.Errorf("Expected TypeLeave after peer disconnect, got %v", leaveEnv.Type)
	}
}

func TestHub_RouteErrors(t *testing.T) {
	hub := NewHub()
	// Create a dummy client without starting ReadPump/WritePump
	dummyClient := &Client{Send: make(chan []byte, 10)}

	// Test unsupported version
	rawJson := []byte(`{"v": 2, "type": "join", "room": "room1"}`)
	hub.RouteMessage(dummyClient, rawJson)
	
	select {
	case msg := <-dummyClient.Send:
		var env Envelope
		_ = json.Unmarshal(msg, &env)
		if env.Type != TypeError {
			t.Errorf("Expected TypeError for unsupported version, got %s", env.Type)
		}
	default:
		t.Error("Expected error message to be sent")
	}
	
	// Test missing room
	rawJson2 := []byte(`{"v": 1, "type": "join"}`)
	hub.RouteMessage(dummyClient, rawJson2)
	
	select {
	case msg := <-dummyClient.Send:
		var env Envelope
		_ = json.Unmarshal(msg, &env)
		if env.Type != TypeError {
			t.Errorf("Expected TypeError for missing room, got %s", env.Type)
		}
	default:
		t.Error("Expected error message to be sent")
	}

	// Test forwarding to unknown room
	forwardJson := []byte(`{"v": 1, "type": "offer", "room": "ghost-room"}`)
	hub.RouteMessage(dummyClient, forwardJson)
	
	select {
	case msg := <-dummyClient.Send:
		var env Envelope
		_ = json.Unmarshal(msg, &env)
		if env.Type != TypeError {
			t.Errorf("Expected TypeError for forward to ghost-room, got %s", env.Type)
		}
	default:
		t.Error("Expected error message to be sent")
	}
}

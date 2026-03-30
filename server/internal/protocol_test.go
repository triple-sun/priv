package internal

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestEnvelope_JSONMarshaling(t *testing.T) {
	tests := []struct {
		name       string
		envelope   Envelope
		jsonString string
		wantError  bool
	}{
		{
			name: "marshal complete envelope",
			envelope: Envelope{
				Version: 1,
				Type:    TypeJoin,
				Room:    "room-123",
				Token:   "secret-token",
				Payload: json.RawMessage(`{"key":"value"}`),
			},
			jsonString: `{"v":1,"type":"join","room":"room-123","token":"secret-token","payload":{"key":"value"}}`,
			wantError:  false,
		},
		{
			name: "marshal missing token omits token field",
			envelope: Envelope{
				Version: 1,
				Type:    TypeJoin,
				Room:    "room-123",
			},
			jsonString: `{"v":1,"type":"join","room":"room-123"}`,
			wantError:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Test Marshaling
			b, err := json.Marshal(tt.envelope)
			if (err != nil) != tt.wantError {
				t.Fatalf("Marshal() error = %v, wantError %v", err, tt.wantError)
			}
			if string(b) != tt.jsonString {
				t.Errorf("Marshal() = %s, want %s", string(b), tt.jsonString)
			}

			// Test Unmarshaling
			var unmarshaled Envelope
			err = json.Unmarshal([]byte(tt.jsonString), &unmarshaled)
			if (err != nil) != tt.wantError {
				t.Fatalf("Unmarshal() error = %v, wantError %v", err, tt.wantError)
			}

			// For deeper equality check we need to manually verify payload bytes
			if !reflect.DeepEqual(unmarshaled.Payload, tt.envelope.Payload) {
				t.Errorf("Unmarshal() payload = %s, want %s", string(unmarshaled.Payload), string(tt.envelope.Payload))
			}
			
			// Zero out payloads and compare the rest
			unmarshaled.Payload = nil
			tt.envelope.Payload = nil
			if !reflect.DeepEqual(unmarshaled, tt.envelope) {
				t.Errorf("Unmarshal() = %+v, want %+v", unmarshaled, tt.envelope)
			}
		})
	}
}

func TestEnvelope_JSONUnmarshalingValidation(t *testing.T) {
	t.Run("unmarshals invalid json", func(t *testing.T) {
		invalidJSON := `{"v":1, "type":` // missing value and closing brace
		var env Envelope
		err := json.Unmarshal([]byte(invalidJSON), &env)
		if err == nil {
			t.Error("expected error unmarshaling invalid JSON, got none")
		}
	})

	t.Run("rejects numbers in string fields implicitly", func(t *testing.T) {
		wrongTypeJSON := `{"v":1, "type":123, "room":"room1"}`
		var env Envelope
		err := json.Unmarshal([]byte(wrongTypeJSON), &env)
		if err == nil {
			t.Error("expected error unmarshaling number into string field (type MessageType)")
		}
	})
}

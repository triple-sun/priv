package internal

import (
	"encoding/base64"
	"testing"
)

func TestGenerateToken(t *testing.T) {
	t.Run("returns valid base64url string", func(t *testing.T) {
		token, err := generateToken()
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		
		if len(token) == 0 {
			t.Error("expected non-empty token")
		}

		// Verify it's valid base64 URL-encoded
		decoded, err := base64.URLEncoding.DecodeString(token)
		if err != nil {
			t.Errorf("expected valid base64url string, got error decoding: %v", err)
		}
		
		// We expect 32 bytes of entropy as defined in generateToken
		if len(decoded) != 32 {
			t.Errorf("expected 32 bytes of original entropy, got %d", len(decoded))
		}
	})

	t.Run("returns unique tokens", func(t *testing.T) {
		token1, err1 := generateToken()
		token2, err2 := generateToken()

		if err1 != nil || err2 != nil {
			t.Fatalf("expected no errors, got %v and %v", err1, err2)
		}

		if token1 == token2 {
			t.Error("expected randomly generated tokens to be unique, but got duplicates")
		}
	})
}

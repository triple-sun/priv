package internal

import "encoding/json"

type MessageType string

const (
	TypeJoin   MessageType = "join"
	TypeOffer  MessageType = "offer"
	TypeAnswer MessageType = "answer"
	TypeICE    MessageType = "ice"
	TypePubKey MessageType = "pubkey"
	TypeLeave  MessageType = "leave"
	TypeError  MessageType = "error"
)

type Envelope struct {
	Version int             `json:"v"`
	Type    MessageType     `json:"type"`
	Room    string          `json:"room"`
	Token   string          `json:"token,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

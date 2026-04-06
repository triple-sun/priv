package internal

import (
	"crypto/subtle"
	"encoding/json"
	"sync"
)

const maxRoomClients = 2

type Room struct {
	Mu      sync.RWMutex
	Token   string
	Clients map[*Client]struct{}
}

type Hub struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

func NewHub() *Hub {
	return &Hub{
		rooms: make(map[string]*Room),
	}
}

func (h *Hub) handleForward(c *Client, env *Envelope) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	room, exists := h.rooms[env.Room]
	if !exists {
		h.sendError(c, "room does not exist")
		return
	}

	var peer *Client
	for client := range room.Clients {
		if client != c {
			peer = client
			break
		}
	}

	if peer == nil {
		h.sendError(c, "no peer in room")
		return
	}

	env.Token = ""
	b, _ := json.Marshal(env)

	select {
	case peer.Send <- b:
	default:
		// Peer channel is blocked, connection might be dead
	}
}

// RouteMessage parses the raw JSON and dispatches to the appropriate handler
func (h *Hub) RouteMessage(c *Client, rawMessage []byte) {
	var env Envelope
	if err := json.Unmarshal(rawMessage, &env); err != nil {
		h.sendError(c, "invalid JSON or poorly formatted envelope")
		return
	}

	// 2.4 Input validation
	if env.Version != 1 {
		h.sendError(c, "unsupported protocol version")
		return
	}
	if env.Type == "" || env.Room == "" {
		h.sendError(c, "missing type or room")
		return
	}

	switch env.Type {
	case TypeJoin:
		h.handleJoin(c, &env)
	case TypeOffer, TypeAnswer, TypeICE, TypePubKey:
		h.handleForward(c, &env)
	default:
		h.sendError(c, "unknown message type")
	}
}

func (h *Hub) sendError(c *Client, errMsg string) {
	errPayload, _ := json.Marshal(map[string]string{"message": errMsg})
	env := Envelope{
		Version: 1,
		Type:    TypeError,
		Payload: json.RawMessage(errPayload),
	}
	b, _ := json.Marshal(env)

	// Non-blocking send to the client's writePump
	select {
	case c.Send <- b:
	default:
		// Client channel full/closed
	}
}

func (h *Hub) handleJoin(c *Client, env *Envelope) {
	h.mu.Lock()
	defer h.mu.Unlock()

	room, exists := h.rooms[env.Room]
	var created bool
	if !exists {
		token, err := generateToken()
		if err != nil {
			h.sendError(c, "internal server error: couldn't generate token")
			return
		}

		room = &Room{
			Token:   token,
			Clients: make(map[*Client]struct{}),
		}

		h.rooms[env.Room] = room
		created = true
	} else {
		// Room exists: Authenticate
		if subtle.ConstantTimeCompare([]byte(env.Token), []byte(room.Token)) != 1 {
			h.sendError(c, "invalid token")
			return
		}
	}

	// Check if client is ALREADY in the room
	if _, ok := room.Clients[c]; ok {
		// Resend confirmation and return
		respEnvelope := Envelope{Version: 1, Type: TypeJoin, Room: env.Room}
		b, _ := json.Marshal(respEnvelope)
		select {
		case c.Send <- b:
		default:
		}
		return
	}

	// Check capacity
	if len(room.Clients) >= maxRoomClients {
		h.sendError(c, "room is full")
		return
	}

	// Register client
	room.Clients[c] = struct{}{}

	// Send confirmation of successful join
	if created {
		// Return the token to the creator so they can share it
		respPayload, _ := json.Marshal(map[string]string{"token": room.Token})
		respEnvelope := Envelope{Version: 1, Type: TypeJoin, Room: env.Room, Payload: json.RawMessage(respPayload)}
		b, _ := json.Marshal(respEnvelope)
		select {
		case c.Send <- b:
		default:
		}
	} else {
		respEnvelope := Envelope{Version: 1, Type: TypeJoin, Room: env.Room}
		b, _ := json.Marshal(respEnvelope)
		select {
		case c.Send <- b:
		default:
		}
	}
}

func (h *Hub) RemoveClient(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Find which room the client was in
	for roomID, room := range h.rooms {
		if _, ok := room.Clients[c]; ok {
			delete(room.Clients, c)
			close(c.Send)

			if len(room.Clients) == 0 {
				// Room is empty, delete it to prevent memory leaks
				delete(h.rooms, roomID)
			} else {
				// Notify the remaining peer that this user left
				leaveEnv := Envelope{Version: 1, Type: TypeLeave, Room: roomID}
				b, _ := json.Marshal(leaveEnv)
				for peer := range room.Clients {
					select {
					case peer.Send <- b:
					default:
					}
				}
			}
			break
		}
	}
}

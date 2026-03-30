# Phase 2: Signaling Server — Session Negotiation (Detailed Plan)

**Goal:** Two Tauri app instances can discover each other through the signaling server and exchange arbitrary JSON messages (precursor to SDP/ICE).

> [!IMPORTANT]
> This plan is a detailed breakdown of Phase 2 from [PLAN.md](file:///Users/semen/_dev/_pet/priv_chat/.plan/PLAN.md#L49-L81). It does **not** propose code changes — it's a granular implementation guide for you(the developer) to follow.

---

## Step 1 — Server: Message Envelope & Room Model

### 1.1 Define the versioned JSON message protocol

Create `server/internal/protocol.go` to define the shared message protocol. This package architecture ensures clear separation of concerns. Note the explicit `package internal` and necessary imports:

```go
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
```

**Key decisions:**

- `Version` (`v`) — included from the start to support backward-compatible protocol evolution. Current version is `1`.
- `Token` — required on `join` messages for room authentication. Omitted on forwarded messages.
- `TypePubKey` — used in Phase 5 for E2E key exchange. The server forwards it opaquely.
- `Payload` as `json.RawMessage` — the server forwards it opaquely without parsing, decoupling it from SDP/ICE specifics.
- `TypeError` for server → client error responses.

### 1.2 In-memory room and hub model

Create `server/internal/hub.go`. The Hub orchestrates rooms and client registration:

```go
package internal

import (
    "sync"
)

type Room struct {
    Mu      sync.RWMutex
    Token   string
    Clients map[*Client]struct{}
}

type Hub struct {
    Mu    sync.RWMutex
    Rooms map[string]*Room
}

// NewHub initializes the server's central room manager
func NewHub() *Hub {
    return &Hub{
        Rooms: make(map[string]*Room),
    }
}
```

**Constraints:**

- Max **2 clients per room** (1:1 calls for now). Return a `TypeError` envelope if a third peer tries to join.
- Clean up empty rooms when the last client disconnects.
- Use a `sync.RWMutex` for concurrent access — reads are frequent (message routing), writes are rare (join/leave).

### 1.3 Room authentication (invite tokens)

Room access is gated by a cryptographically random invite token. Create `server/internal/token.go`:

```go
package internal

import (
    "crypto/rand"
    "encoding/base64"
)

// GenerateToken creates a URL-safe, 32-byte cryptographic random token
func GenerateToken() (string, error) {
    b := make([]byte, 32)
    if _, err := rand.Read(b); err != nil {
        return "", err
    }
    return base64.URLEncoding.EncodeToString(b), nil
}
```

- **Room creation**: The first client joining an unknown room gets a generated token, securely stored on the `Room` struct.
- **Room joining**: Subsequent `join` messages must provide a matching token.
- **Why here, not later**: E2E public keys are exchanged over signaling. Auth prevents MITM attackers substituting keys.

### 1.4 Client Concurrency Model (Gorilla WebSocket Patterns)

> [!NOTE]
> **📚 Concept: Go's CSP Model & the ReadPump/WritePump Pattern**
>
> Go's concurrency philosophy (CSP — Communicating Sequential Processes) says: *don't share memory, communicate through channels*. A `gorilla/websocket` connection is not goroutine-safe for concurrent writes. The solution is one goroutine that only reads (`ReadPump`) and one that only writes (`WritePump`), communicating via a buffered `chan []byte`. The `WritePump` is the sole owner of the write side of the connection — no other goroutine ever calls `conn.WriteMessage` directly. This is the canonical pattern in every gorilla/websocket-based server.
>
> **Pitfall**: Calling `conn.WriteMessage` from two goroutines simultaneously panics with "concurrent write to websocket connection". The buffered channel (`Send chan []byte`) is the safe handoff point.

WebSockets connections (`websocket.Conn`) are *not* safe for concurrent writes. You must spawn two goroutines—a **readPump** and a **writePump**—per connected client. Create `server/internal/client.go`:

```go
package internal

import (
    "github.com/gorilla/websocket"
)

type Client struct {
    Conn *websocket.Conn
    Send chan []byte
}

// ReadPump listens for incoming messages from the WebSocket.
// It parses the envelope and dispatches it to the Hub for processing.
func (c *Client) ReadPump(hub *Hub) {
    defer func() {
        // TODO: Disconnect handler logic goes here (remove client from room, close connection)
        c.Conn.Close()
    }()

    for {
        _, message, err := c.Conn.ReadMessage()
        if err != nil {
            break // Break cleanly on disconnects or errors
        }
        
        // TODO: Unmarshal into Envelope and route message via Hub
        _ = message
    }
}

// WritePump pushes queued messages from the Send channel onto the WebSocket.
func (c *Client) WritePump() {
    defer func() {
        c.Conn.Close()
    }()

    for {
        select {
        case message, ok := <-c.Send:
            if !ok {
                // The Hub closed the channel
                c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }

            if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
                return
            }
        }
    }
}
```

This ensures zero data races and properly handles dropped connections via the standard `gorilla/websocket` paradigm.

---

## Step 2 — Server: Message Routing

To ensure correct and safe concurrent access to the room state, all routing logic should be encapsulated in methods on the `Hub` object.

### 2.1 The Main Message Router

In `server/internal/client.go` (from Step 1.4), we left a `TODO: Unmarshal into Envelope and route message via Hub`. Let's implement that by adding a `RouteMessage` method to the Hub.

Add the following to `server/internal/hub.go`:

```go
import (
    "encoding/json"
)

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

// sendError is a helper to push an error back to the sending client
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
```

### 2.2 The `join` Handler

Add `handleJoin` to `server/internal/hub.go` to handle room creation or authenticated joining:

```go
import "crypto/subtle"

> [!NOTE]
> **📚 Concept: `sync.RWMutex` — Readers vs. Writers**
>
> `handleJoin` **modifies** the rooms map (creates or updates a room), so it must hold an exclusive write lock: `h.Mu.Lock()`. Compare this to `handleForward` below, which only **reads** which peer is in the room — it holds a shared read lock `h.Mu.RLock()`, allowing multiple goroutines to forward messages concurrently.
>
> Rule of thumb: `Lock()` when you write. `RLock()` when you only read. Using `Lock()` everywhere is correct but serialises all reads unnecessarily.
>
> **Pitfall**: Always `defer mu.Unlock()` / `defer mu.RUnlock()` immediately after locking — if the function returns early (e.g., error path), the deferred unlock still runs.

func (h *Hub) handleJoin(c *Client, env *Envelope) {
    h.Mu.Lock()
    defer h.Mu.Unlock()

    room, exists := h.Rooms[env.Room]
    if !exists {
        // Room doesn't exist: Create it
        token, err := GenerateToken()
        if err != nil {
            h.sendError(c, "internal server error: couldn't generate token")
            return
        }
        
        room = &Room{
            Token:   token,
            Clients: make(map[*Client]struct{}),
        }
        h.Rooms[env.Room] = room

        // Return the token to the creator so they can share it
        respPayload, _ := json.Marshal(map[string]string{"token": token})
        respEnv := Envelope{Version: 1, Type: TypeJoin, Room: env.Room, Payload: json.RawMessage(respPayload)}
        b, _ := json.Marshal(respEnv)
        c.Send <- b
    } else {
        // Room exists: Authenticate
        if subtle.ConstantTimeCompare([]byte(env.Token), []byte(room.Token)) != 1 {
            h.sendError(c, "invalid token")
            return
        }
    }

    // Check capacity
    if len(room.Clients) >= 2 {
        h.sendError(c, "room is full")
        return
    }

    // Register client
    room.Clients[c] = struct{}{}
}
```

### 2.3 The Forwarding Handler

Add `handleForward` to `server/internal/hub.go`. This relays WebRTC signals to the *other* person in the room.

```go
func (h *Hub) handleForward(c *Client, env *Envelope) {
    h.Mu.RLock() // RLock since we aren't modifying room state, just reading it
    defer h.Mu.RUnlock()

    room, exists := h.Rooms[env.Room]
    if !exists {
        h.sendError(c, "room does not exist")
        return
    }

    // Find the peer (the client in the room that is NOT the sender)
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

    // Strip the token before forwarding so it doesn't leak unnecessarily
    env.Token = ""
    b, _ := json.Marshal(env)

> [!NOTE]
> **📚 Concept: Non-Blocking Channel Send**
>
> `select { case peer.Send <- b: default: }` is Go's idiom for a **non-blocking send**. If the channel is full (peer is slow or dead), the `default` branch runs and we skip the message rather than blocking our goroutine — and by extension, blocking every other client waiting on the hub's mutex.
>
> A blocking send here would be catastrophic: one slow client could freeze message delivery for everyone in every room. The `default` drop is the right trade-off — if the channel is consistently full, the peer's `WritePump` will detect the dead connection via the heartbeat timeout and clean up.

    select {
    case peer.Send <- b:
    default:
        // Peer channel is blocked, connection might be dead
    }
}
```

### 2.4 The Disconnect Handler

When a socket errors or drops, we must clean up. Update `ReadPump` in `server/internal/client.go` to explicitly invoke `RemoveClient`:

```go
func (c *Client) ReadPump(hub *Hub) {
    defer func() {
        hub.RemoveClient(c) // Clean up on disconnect
        c.Conn.Close()
    }()

    for {
        _, message, err := c.Conn.ReadMessage()
        if err != nil {
            break 
        }
        hub.RouteMessage(c, message)
    }
}
```

And add `RemoveClient` to `server/internal/hub.go`:

```go
func (h *Hub) RemoveClient(c *Client) {
    h.Mu.Lock()
    defer h.Mu.Unlock()

    // Find which room the client was in
    for roomID, room := range h.Rooms {
        if _, ok := room.Clients[c]; ok {
            delete(room.Clients, c)
            close(c.Send)

            if len(room.Clients) == 0 {
                // Room is empty, delete it to prevent memory leaks
                delete(h.Rooms, roomID)
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
```

This completes a robust, structurally sound signaling router.

---

## Step 3 — Server: Heartbeat

### 3.1 Ping/Pong Implementation

> [!NOTE]
> **📚 Concept: TCP Keepalives vs. Application-Level Heartbeats**
>
> TCP has built-in keepalives, but they are disabled by default and operate at timescales of minutes (OS-configured, often 2 hours). NAT routers and firewalls silently kill "idle" TCP connections after 30–90 seconds with no traffic — *without sending a TCP RST*. Your application will not know the connection is dead until it tries to write and gets an error, which may never happen if no messages are being sent.
>
> Application-level ping/pong solves this: our server sends a WebSocket `Ping` frame every 30 seconds. The client's WebSocket library auto-responds with a `Pong`. If no Pong arrives within 40 seconds, the read deadline fires → `ReadMessage` returns an error → `ReadPump` exits → `RemoveClient` cleans up the room.
>
> **Pitfall**: Setting `pingPeriod >= pongWait` — if the ping is sent exactly as often as we wait for a pong, the connection will time out before the pong can arrive. `pingPeriod` must always be less than `pongWait`.

WebSocket connections can silently drop behind firewalls or NATs. To detect dead clients and aggressively clean up rooms, we must implement a server-side heartbeat.

The `gorilla/websocket` library requires us to enforce deadlines natively. Clients will automatically respond to `Ping` frames with `Pong` frames.

First, add these constants to `server/internal/client.go`:

```go
import "time"

const (
    // Time allowed to read the next pong message from the peer.
    pongWait = 40 * time.Second

    // Send pings to peer with this period. Must be less than pongWait.
    pingPeriod = 30 * time.Second
)
```

Next, update `ReadPump` in `server/internal/client.go` to enforce the read deadline and reset it whenever a Pong is received:

```go
func (c *Client) ReadPump(hub *Hub) {
    defer func() {
        hub.RemoveClient(c)
        c.Conn.Close()
    }()

    // Configure the heartbeat deadlines
    c.Conn.SetReadDeadline(time.Now().Add(pongWait))
    c.Conn.SetPongHandler(func(string) error {
        c.Conn.SetReadDeadline(time.Now().Add(pongWait))
        return nil
    })

    for {
        _, message, err := c.Conn.ReadMessage()
        if err != nil {
            break // Triggered if the client disconnects OR if pongWait elapses
        }
        hub.RouteMessage(c, message)
    }
}
```

Finally, update `WritePump` in `server/internal/client.go` to include a ticker that pushes `Ping` messages to the client at the `pingPeriod` interval:

```go
func (c *Client) WritePump() {
    ticker := time.NewTicker(pingPeriod)
    defer func() {
        ticker.Stop()
        c.Conn.Close()
    }()

    for {
        select {
        case message, ok := <-c.Send:
            if !ok {
                c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }

            if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
                return
            }
            
        case <-ticker.C:
            // Heartbeat: Send Ping
            if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return // If ping fails, connection is dead. Exit writePump.
            }
        }
    }
}
```

This completes the robust signaling architecture. Undetected drops ("ghost clients") will be swept out strictly after 40 seconds.

---

## Step 4 — Client: `SignalingService`

### 4.1 Types

Create `src/types/signaling.ts` and ensure you **export** the types so they can be imported and used elsewhere:

```ts
export type MessageType = "join" | "offer" | "answer" | "ice" | "pubkey" | "leave" | "error";

export interface Envelope {
  v: number;
  type: MessageType;
  room: string;
  token?: string;
  payload?: unknown;
}
```

### 4.2 Create `src/services/signaling.ts`

> [!NOTE]
> **📚 Concept: The Browser WebSocket State Machine & the `intentionallyDisconnected` Flag**
>
> A browser `WebSocket` object transitions through four states: `CONNECTING (0)` → `OPEN (1)` → `CLOSING (2)` → `CLOSED (3)`. The `onclose` event fires for *both* intentional disconnects (you called `ws.close()`) and unexpected ones (server crash, network drop). Without the `intentionallyDisconnected` flag, your reconnect logic would fire even when you deliberately left a room.
>
> The exponential backoff pattern (`min(1000 × 2^attempt, 30000)ms`) prevents a thundering herd: if a server restarts and 1000 clients all reconnect at the same instant, they could overwhelm it. Spreading reconnects geometrically gives the server time to recover.
>
> **Pitfall**: Registering message listeners inside `onopen` without removing them — if `onopen` fires multiple times (reconnects), you accumulate duplicate listeners. The `messageListeners` array + the returned unsubscription function prevents this.

This service encapsulates the WebSocket logic, event emitting, and automatic reconnection.

```text
src/
  services/
    signaling.ts   ← new
```

Here is a robust, ready-to-use implementation. It handles JSON parsing, room state, emitting events to multiple listeners, and tracking intentional vs. unintentional disconnects for automatic exponential backoff. You can copy and paste this directly:

```ts
import { Envelope, MessageType } from "../types/signaling";

export class SignalingService {
  private ws: WebSocket | null = null;
  private url: string = "";
  private currentRoom: string | null = null;
  private currentToken: string | null = null;
  private messageListeners: ((env: Envelope) => void)[] = [];
  
  private reconnectAttempt = 0;
  private reconnectTimeoutId: number | null = null;
  private intentionallyDisconnected = false;

  public connect(url: string): void {
    this.url = url;
    this.intentionallyDisconnected = false;
    this.initWebSocket();
  }

  private initWebSocket() {
    if (this.ws) {
      this.ws.close();
    }
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log("[Signaling] Connected to server");
      this.reconnectAttempt = 0;
      
      // Auto re-join the room upon successful reconnection
      if (this.currentRoom) {
        this.joinRoom(this.currentRoom, this.currentToken || undefined);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const envelope: Envelope = JSON.parse(event.data);
        
        // Save the token when the server generates and returns it
        if (envelope.type === "join" && envelope.payload && typeof envelope.payload === "object") {
          const payloadRecord = envelope.payload as Record<string, any>;
          if (payloadRecord.token) {
            this.currentToken = payloadRecord.token;
          }
        }

        this.messageListeners.forEach(listener => listener(envelope));
      } catch (err) {
        console.error("[Signaling] Failed to parse message:", err);
      }
    };

    this.ws.onclose = () => {
      console.log("[Signaling] Disconnected");
      this.ws = null;
      if (!this.intentionallyDisconnected) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error("[Signaling] WebSocket error:", err);
    };
  }

  public joinRoom(roomId: string, token?: string): void {
    this.currentRoom = roomId;
    this.currentToken = token || null; // Will be set by server response if created
    
    this.sendRaw({
      v: 1,
      type: "join",
      room: roomId,
      token: token,
    });
  }

  public send(type: MessageType, payload?: unknown): void {
    if (!this.currentRoom) {
      console.error("[Signaling] Cannot send message: not in a room");
      return;
    }
    
    this.sendRaw({
      v: 1,
      type,
      room: this.currentRoom,
      payload,
    });
  }

  private sendRaw(envelope: Envelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error("[Signaling] Cannot send: WebSocket is not open");
      return;
    }
    this.ws.send(JSON.stringify(envelope));
  }

  // Returns a function to unsubscribe the listener
  public onMessage(callback: (envelope: Envelope) => void): () => void {
    this.messageListeners.push(callback);
    return () => {
      this.messageListeners = this.messageListeners.filter(l => l !== callback);
    };
  }

  public disconnect(): void {
    this.intentionallyDisconnected = true;
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    
    // Attempt graceful leave
    if (this.currentRoom && this.ws && this.ws.readyState === WebSocket.OPEN) {
       this.sendRaw({ v: 1, type: "leave", room: this.currentRoom });
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.currentRoom = null;
    this.currentToken = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimeoutId !== null) return;

    // Exponential backoff: min(1000 * 2^attempt, 30000)
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000);
    console.log(`[Signaling] Reconnecting in ${delay}ms...`);
    
    this.reconnectTimeoutId = window.setTimeout(() => {
      this.reconnectTimeoutId = null;
      this.reconnectAttempt++;
      this.initWebSocket();
    }, delay);
  }
}

// Export a singleton instance for global use throughout the React app
export const signalingService = new SignalingService();
```

### 4.3 Reconnection and State Management Details

- **Automatic Reconnection:** If `WebSocket.onclose` is triggered and `this.intentionallyDisconnected` is false, it uses exponential backoff (`min(1000 * 2^attempt, 30000)`) to schedule a reconnect.
- **Room State Persistence:** The service keeps track of the `currentRoom` and `currentToken`. Once the socket reconnects and `onopen` fires, it immediately attempts to re-join the room automatically, completely seamlessly from the perspective of the rest of the application.
- **Listener Cleanup:** `onMessage` returns an unsubscription function so that components can clean up when they unmount (e.g. `useEffect` cleanup).

---

## Step 5 — Client: Minimal Lobby UI

### 5.1 Replace the Tauri starter in `App.tsx`

The lobby screen needs to rapidly test our `SignalingService` connection, token generation, joining rooms, and sending generic WebRTC signal placeholders.

Instead of building it from scratch from bulleted specs, entirely replace `src/App.tsx` with this functional, fully-integrated React implementation:

```tsx
import { useEffect, useState, useRef } from "react";
import { signalingService } from "./services/signaling";
import { Envelope } from "./types/signaling";
import "./App.css";

function App() {
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [roomId, setRoomId] = useState("");
  const [token, setToken] = useState("");
  const [inRoom, setInRoom] = useState(false);
  const [messages, setMessages] = useState<Envelope[]>([]);
  const [outgoingMsg, setOutgoingMsg] = useState("");
  
  const endOfMessagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 1. Connect to the WebSocket server on mount.
    // Replace the URL's port/host with your actual local signaling server details
    setStatus("connecting");
    const wsUrl = "ws://127.0.0.1:8080/ws";
    signalingService.connect(wsUrl);
    setStatus("connected");

    // 2. Attach our listener to capture and log signaling envelopes
    const unsubscribe = signalingService.onMessage((envelope) => {
      console.log("Received via WS:", envelope);
      setMessages((prev) => [...prev, envelope]);

      // If securely joined, update the UI and capture the token
      if (envelope.type === "join") {
        setInRoom(true);
        const payload = envelope.payload as Record<string, any>;
        if (payload?.token) {
          setToken(payload.token);
        }
      }
      
      // If the peer disconnected or we were booted
      if (envelope.type === "leave") {
         setInRoom(false);
      }
    });

    // Clean up websocket listeners upon component unmount
    return () => {
      unsubscribe();
      signalingService.disconnect();
    };
  }, []);

  // Auto-scroll messaging widget downwards
  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomId.trim()) return;
    
    setMessages([]);
    signalingService.joinRoom(roomId, token.trim() || undefined);
  };

  const handleDisconnectAction = () => {
    signalingService.disconnect();
    setInRoom(false);
    setStatus("disconnected");
    setToken("");
    
    // Auto-reconnect purely for rapid testing in this lobby
    setTimeout(() => {
      signalingService.connect("ws://127.0.0.1:8080/ws");
      setStatus("connected");
    }, 500);
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!outgoingMsg.trim() || !inRoom) return;

    // We use "offer" here as a generic placeholder for testing message exchange
    signalingService.send("offer", { text: outgoingMsg });
    setOutgoingMsg("");
  };

  return (
    <div className="container" style={{ padding: "20px", fontFamily: "sans-serif" }}>
      <h1>PrivChat Lobby</h1>
      
      <div style={{ marginBottom: "20px" }}>
        Status: <strong style={{ color: status === "connected" ? "green" : "red" }}>{status}</strong>
      </div>

      {!inRoom ? (
        <form onSubmit={handleJoin} style={{ display: "flex", flexDirection: "column", gap: "10px", maxWidth: "300px" }}>
          <label>
            Room ID:
            <input
              type="text"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              placeholder="e.g. test-room"
              style={{ width: "100%", padding: "5px" }}
              required
            />
          </label>
          <label>
            Invite Token (Optional):
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Leave blank to create a new room"
              style={{ width: "100%", padding: "5px" }}
            />
          </label>
          <button type="submit" style={{ padding: "10px 15px", cursor: "pointer" }}>Join / Create</button>
        </form>
      ) : (
        <div style={{ border: "1px solid #ccc", padding: "15px", borderRadius: "8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px" }}>
            <h2>Room: {roomId}</h2>
            <button onClick={handleDisconnectAction} style={{ padding: "5px 10px", background: "red", color: "white", border: "none" }}>
              Leave
            </button>
          </div>
          
          <div style={{ background: "#f5f5f5", padding: "10px", marginBottom: "15px" }}>
            <strong>Invite Token: </strong> {token}
            <button
              onClick={() => navigator.clipboard.writeText(token)}
              style={{ marginLeft: "10px", padding: "2px 8px" }}
            >
              Copy
            </button>
          </div>

          <div style={{ height: "200px", overflowY: "auto", border: "1px solid #000", padding: "10px", marginBottom: "15px" }}>
            {messages.map((msg, i) => (
              <div key={i} style={{ padding: "5px", borderBottom: "1px solid #eee" }}>
                <span style={{ fontWeight: "bold", marginRight: "10px" }}>[{msg.type}]</span>
                <span>{JSON.stringify(msg.payload)}</span>
              </div>
            ))}
            <div ref={endOfMessagesRef} />
          </div>

          <form onSubmit={handleSendMessage} style={{ display: "flex", gap: "10px" }}>
            <input
              type="text"
              value={outgoingMsg}
              onChange={(e) => setOutgoingMsg(e.target.value)}
              placeholder="Type a test message..."
              style={{ flex: 1, padding: "5px" }}
            />
            <button type="submit" style={{ padding: "5px 15px" }}>Send</button>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;
```

> [!IMPORTANT]
> The UI includes inline styles instead of requiring a separate `.css` dump so you can verify Phase 2 instantly. Do not over-invest in refining it — it will be thrown away and thoroughly replaced in Phase 3 when integrating the actual video WebRTC feeds and layout.

---

## Step 6 — Server: Tests

Testing concurrent WebSocket servers is notoriously tricky. Your tests must avoid race conditions while verifying asynchronous message delivery. We'll use the `httptest` package and `gorilla/websocket` client dialer.

### 6.1 Set up a Test Server Helper

First, create a helper to easily spin up a test instance of your server and connect clients. Create `server/internal/hub_test.go`:

```go
package internal

import (
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "strings"
 "testing"

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
```

### 6.2 Writing the Integration Tests

Instead of mocking internal Hub methods, it is safer to test the Hub end-to-end via WebSockets. Add tests in `server/internal/hub_test.go` to systematically verify the protocol.

**Test 1: Room Creation and Token Generation**
Verify that joining an empty room generates a valid token, and the sender receives it.

```go
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
```

**Test 2: Two-Peer Message Forwarding**
Verify that a second client can join with the correct token, and that messages are forwarded.

```go
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

 // (A brief synchronization step might be needed here in real tests to ensure join completes before sending,
 // but for this example, gorilla handles the JSON read/write sequentially enough if we pause or listen for events)

 // 3. Client 1 sends an offer
 offerPayload := []byte(`{"sdp": "dummy"}`)
 conn1.WriteJSON(Envelope{Version: 1, Type: TypeOffer, Room: "test-room", Payload: json.RawMessage(offerPayload)})

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
```

### 6.3 Required Test Scenarios to Complete

Following the pattern above, implement the remaining edge cases to guarantee stability:

- **Invalid Token Rejection**: Client 1 creates a room; Client 2 attempts to join with `Token: "bad-token"`. Verify Client 2 receives a `TypeError` envelope and is not added to the room.
- **Max Capacity**: Client 1 and 2 join successfully. Client 3 attempts to join with the correct token. Verify Client 3 receives a `TypeError` indicating the room is full.
- **Disconnect Notification**: Client 1 and 2 join successfully. `conn1.Close()` is called. Client 2 reads from the socket and should receive a `TypeLeave` envelope.
- **Bad Envelope Protection**: Send garbled JSON, `Version: 999`, or missing fields via `conn.WriteMessage`. Ensure the server doesn't panic and returns a `TypeError`.

Run the tests strictly with the race detector enabled to catch concurrent map read/writes:

```bash
cd server && go test ./... -v -race
```

---

## File Summary

| File                          | Action     | Purpose                                   |
| ----------------------------- | ---------- | ----------------------------------------- |
| `server/internal/protocol.go` | **NEW**    | Message types and `Envelope` struct       |
| `server/internal/hub.go`      | **NEW**    | `Hub` and `Room` structs, room management |
| `server/internal/client.go`   | **NEW**    | `Client` struct, `readPump`, `writePump`  |
| `server/internal/token.go`    | **NEW**    | Invite token generation logic             |
| `server/main.go`              | **MODIFY** | Wire up the hub, replace echo handler     |
| `server/internal/hub_test.go` | **NEW**    | Unit tests for hub/room logic             |
| `server/integration_test.go`  | **NEW**    | WebSocket integration test                |
| `src/types/signaling.ts`      | **NEW**    | TypeScript types for the protocol         |
| `src/services/signaling.ts`   | **NEW**    | WebSocket client service                  |
| `src/App.tsx`                 | **MODIFY** | Replace starter with lobby UI             |
| `src/App.css`                 | **MODIFY** | Minimal lobby styles                      |

---

## Verification Plan

### Automated Tests

```bash
# Run Go server tests with race detector
cd server && go test ./... -v -race
```

### Manual Verification

> [!NOTE]
> These require running both the server and two Tauri app instances simultaneously.

1. **Room creation and token sharing:**
   - Start the server: `make dev-server`
   - Start Instance A: `make dev-app`
   - Enter room ID `"test"`, leave token blank, click "Join"
   - Verify a generated invite token is displayed

2. **Two-peer message exchange with token:**
   - Start Instance B: `make dev-app`
   - Enter room ID `"test"` and paste the invite token from Instance A
   - Click "Join" → should succeed
   - Type and send a message from Instance A → appears in Instance B's log
   - Type and send a message from Instance B → appears in Instance A's log

3. **Invalid token rejection:**
   - Open a third Tauri instance, enter room `"test"` with a **wrong** token
   - Click "Join" → should see an error message (`"invalid token"`)

4. **Room full rejection:**
   - With two peers already in room `"test"`, open a fourth instance with a valid token
   - Join room `"test"` → should see an error message (`"room is full"`)

5. **Auto-reconnect:**
   - With two peers connected, kill the server (`Ctrl+C`)
   - Restart the server
   - Both clients should reconnect automatically (visible in the connection status indicator and server logs)

6. **Disconnect notification:**
   - With two peers connected, close one Tauri window
   - The remaining peer should see a `leave` event in its message log

---

## Estimated Time: 2–3 days

---

## Understanding Check

> [!IMPORTANT]
> Answer these **without looking** before advancing to Phase 3. They test synthesis, not recall.

1. **ReadPump/WritePump**: You remove `WritePump` and instead call `conn.WriteMessage` directly from `RouteMessage` inside `ReadPump`. The code compiles. Describe exactly what error you'll see at runtime and under what condition it will appear.

2. **`RWMutex` trade-off**: You're reviewing a colleague's PR that replaces every `RLock`/`RUnlock` call in `handleForward` with `Lock`/`Unlock`. Their reasoning: "It's simpler and still correct." Are they right that it's correct? Is it a good change? What's the concrete cost?

3. **Heartbeat mechanics**: The server sends a `Ping` every 30 seconds and waits 40 seconds for a `Pong`. A client's connection dies silently at T=0 (no TCP RST sent). At what time does the server's `ReadPump` return an error? Walk through the chain of events.

4. **`intentionallyDisconnected`**: A user clicks "Leave Room". Your code sets `intentionallyDisconnected = true` and calls `ws.close()`. One second later, the server restarts. Trace what happens in the `SignalingService` for each event, and explain why the flag is still the right design even though the server restarted.

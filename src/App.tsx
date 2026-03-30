import { useEffect, useState, useRef } from "react";
import { signalingService } from "./services/signaling";
import { Envelope } from "./types/signaling";
import "./App.css";

function App() {
  const [status, setStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const [roomId, setRoomId] = useState("");
  const [token, setToken] = useState("");
  const [inRoom, setInRoom] = useState(false);
  const [messages, setMessages] = useState<Envelope[]>([]);
  const [outgoingMsg, setOutgoingMsg] = useState("");

  const endOfMessagesRef = useRef<HTMLDivElement>(null);

  const address = import.meta.env.VITE_SIGNALING_ADDRESS ?? "localhost";
  const port = import.meta.env.VITE_SIGNALING_PORT ?? "8080";

  useEffect(() => {
    // 1. Connect to the WebSocket server on mount.
    // Replace the URL's port/host with your actual local signaling server details
    setStatus("connecting");

    const wsUrl = `ws://${address}:${port}/ws`;
    
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

        console.log({ payload });

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
      signalingService.connect(`ws://${address}:${port}/ws`);
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
    <div
      className="container"
      style={{ padding: "20px", fontFamily: "sans-serif" }}
    >
      <h1>PrivChat Lobby</h1>

      <div style={{ marginBottom: "20px" }}>
        Status:{" "}
        <strong style={{ color: status === "connected" ? "green" : "red" }}>
          {status}
        </strong>
      </div>

      {!inRoom ? (
        <form
          onSubmit={handleJoin}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            maxWidth: "300px",
          }}
        >
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
          <button
            type="submit"
            style={{ padding: "10px 15px", cursor: "pointer" }}
          >
            Join / Create
          </button>
        </form>
      ) : (
        <div
          style={{
            border: "1px solid #ccc",
            padding: "15px",
            borderRadius: "8px",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "10px",
            }}
          >
            <h2>Room: {roomId}</h2>
            <button
              onClick={handleDisconnectAction}
              style={{
                padding: "5px 10px",
                background: "red",
                color: "white",
                border: "none",
              }}
            >
              Leave
            </button>
          </div>

          <div
            style={{
              background: "#f5f5f5",
              padding: "10px",
              marginBottom: "15px",
            }}
          >
            <strong>Invite Token: </strong> {token}
            <button
              onClick={() => navigator.clipboard.writeText(token)}
              style={{ marginLeft: "10px", padding: "2px 8px" }}
            >
              Copy
            </button>
          </div>

          <div
            style={{
              height: "200px",
              overflowY: "auto",
              border: "1px solid #000",
              padding: "10px",
              marginBottom: "15px",
            }}
          >
            {messages.map((msg, i) => (
              <div
                key={i}
                style={{ padding: "5px", borderBottom: "1px solid #eee" }}
              >
                <span style={{ fontWeight: "bold", marginRight: "10px" }}>
                  [{msg.type}]
                </span>
                <span>{JSON.stringify(msg.payload)}</span>
              </div>
            ))}
            <div ref={endOfMessagesRef} />
          </div>

          <form
            onSubmit={handleSendMessage}
            style={{ display: "flex", gap: "10px" }}
          >
            <input
              type="text"
              value={outgoingMsg}
              onChange={(e) => setOutgoingMsg(e.target.value)}
              placeholder="Type a test message..."
              style={{ flex: 1, padding: "5px" }}
            />
            <button type="submit" style={{ padding: "5px 15px" }}>
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;

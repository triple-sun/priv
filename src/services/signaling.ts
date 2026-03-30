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
    if (this.ws) this.ws.close();

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
        if (
          envelope.type === "join" &&
          envelope.payload &&
          typeof envelope.payload === "object"
        ) {
          const payloadRecord = envelope.payload as Record<string, any>;
          if (payloadRecord.token) {
            this.currentToken = payloadRecord.token;
          }
        }

        this.messageListeners.forEach((listener) => listener(envelope));
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
      this.messageListeners = this.messageListeners.filter(
        (l) => l !== callback,
      );
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

    if (this.ws?.OPEN || this.ws?.CONNECTING) {
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

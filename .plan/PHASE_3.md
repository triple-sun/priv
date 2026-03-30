# Phase 3: 1-on-1 WebRTC Video Call (Detailed Plan)

**Goal:** Two Tauri app instances establish a live, peer-to-peer video call using `RTCPeerConnection`, routed through the Phase 2 signaling server for SDP/ICE exchange. No custom E2E encryption yet — that's Phase 5.

> [!IMPORTANT]
> This plan is a detailed breakdown of Phase 3 from [PLAN.md](file:///Users/semen/_dev/_pet/priv_chat/.plan/PLAN.md#L92-L134). It does **not** propose code changes — it's a granular implementation guide for the developer.

---

## Learning Objectives for This Phase

By completing Phase 3, you will understand:

- **The WebRTC offer/answer exchange** — what SDP encodes, why the call ordering is strict, and what happens if you get it wrong
- **ICE and network traversal** — how peers discover each other across NATs, the role of STUN vs. TURN, and why trickle ICE matters for speed
- **The `RTCPeerConnection` state machine** — how to read `iceConnectionState`, `connectionState`, and `signalingState` to understand what's happening at any moment
- **Media tracks** — `getUserMedia`, `addTrack`, and how the `ontrack` event delivers the remote stream
- **Tauri webview compatibility** — which WebRTC features require verification on WebKit vs WebView2

---

## Concept Primer: How a WebRTC Call Works

Before writing any code, read this mental model. Everything in Phase 3 maps to these steps.

> [!NOTE]
> **📚 The Offer/Answer State Machine**
>
> WebRTC connection setup follows a strict negotiation dance called JSEP (JavaScript Session Establishment Protocol):
>
> ```
> Caller (Alice)                          Callee (Bob)
> ─────────────────────────────────────────────────────
> 1. addTrack(localStream)
> 2. createOffer() ─────────────────────────────────►
>    setLocalDescription(offer)           3. setRemoteDescription(offer)
>                                         4. createAnswer()
>                                            setLocalDescription(answer)
> 5. setRemoteDescription(answer) ◄────────────────────
>
> (ICE candidates flow both directions as they are gathered)
> ```
>
> **Why ordering matters**: `setLocalDescription` triggers ICE gathering. `setRemoteDescription` tells the ICE agent what IP/ports the peer is willing to accept. Calling them in the wrong order (e.g., `setRemoteDescription` before `createOffer`) corrupts the `signalingState` and the connection will never proceed.
>
> **The SDP blob**: a Session Description Protocol text block that encodes: supported codecs, preferred bitrates, fingerprint for DTLS, and ice-ufrag/pwd (ICE credentials). You don't usually need to parse it — just pass it opaquely through signaling.

> [!NOTE]
> **📚 ICE: How Peers Find Each Other**
>
> ICE (Interactive Connectivity Establishment, RFC 8445) is the process of gathering all possible network paths ("candidates") and testing which one works:
>
> | Candidate Type | What it is |
> |---------------|-----------|
> | **host** | Your local IP (e.g., `192.168.1.5:50001`) |
> | **srflx** (server-reflexive) | Your public IP as seen by the STUN server |
> | **relay** | A TURN server relay address — the fallback |
>
> **Trickle ICE**: As candidates are discovered, they are sent to the peer *immediately* via signaling — not waited for. This is why you see `onicecandidate` events firing for each candidate. Sending them quickly speeds up connection setup.
>
> **When TURN is required**: If both peers are behind symmetric NATs (common in corporate networks, mobile hotspots), their source port is randomised per destination — STUN can't help because the reflected address is useless to the other peer. A TURN relay bypasses this entirely: both peers connect to the relay, which forwards traffic between them.
>
> **Rule of thumb**: ~85% of connections succeed with STUN alone (home routers, most ISPs). For the remaining ~15%, TURN is mandatory. A production app without TURN will silently fail for a significant user segment.

---

## Step 1 — Camera & Microphone Access

### 1.1 Request media permissions

```ts
// src/services/media.ts
/**
 * Requests camera and microphone access.
 * Returns the local MediaStream or throws with a user-facing error message.
 */
export async function getLocalStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, frameRate: 30 },
      audio: true,
    });
  } catch (err) {
    if (err instanceof DOMException) {
      if (err.name === "NotAllowedError") {
        throw new Error("Camera/microphone permission denied. Please allow access in your browser settings.");
      }
      if (err.name === "NotFoundError") {
        throw new Error("No camera or microphone found. Please connect a device and try again.");
      }
    }
    throw err;
  }
}
```

> [!NOTE]
> **📚 `getUserMedia` Constraints**
>
> The constraints object `{ video: { width, height, frameRate } ... }` are *hints* to the browser, not hard requirements. The browser will get as close as possible. Use `MediaStreamTrack.getSettings()` after the call to see what was actually negotiated with the hardware.
>
> **Pitfall**: Not handling `NotAllowedError` — if the user denies permission (or Tauri's webview hasn't been granted the entitlement), `getUserMedia` rejects. Always show a useful error message, not an unhandled Promise rejection.

### 1.2 Render the local stream

In your call component, attach the local stream to a muted `<video>` element:

```tsx
const videoRef = useRef<HTMLVideoElement>(null);

useEffect(() => {
  if (videoRef.current && localStream) {
    videoRef.current.srcObject = localStream;
  }
}, [localStream]);

// In JSX:
<video ref={videoRef} autoPlay muted playsInline style={{ transform: "scaleX(-1)" }} />
```

> [!NOTE]
> **Why `muted`?** Without it, the browser plays your own microphone audio back to you with a delay — an unpleasant echo. The `muted` attribute prevents this for the local preview only; the audio still flows outbound to the peer.
>
> **Why `playsInline`?** On iOS WebKit (relevant if ever ported), videos without `playsInline` go fullscreen automatically. It's a safe attribute everywhere.
>
> **Why `scaleX(-1)`?** Mirrors the local preview horizontally, matching the experience of looking in a mirror. The remote peer sees the unmirrored stream.

---

## Step 2 — `RTCPeerConnection` Setup

### 2.1 Create the `WebRTCService`

Create `src/services/webrtc.ts`. This class wraps `RTCPeerConnection` and owns the call lifecycle:

```ts
import { signalingService } from "./signaling";
import type { Envelope } from "../types/signaling";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  // Add TURN credentials here for production:
  // { urls: "turn:your-turn-server.com:3478", username: "user", credential: "pass" }
];

export class WebRTCService {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  public onRemoteStream: ((stream: MediaStream) => void) | null = null;
  public onConnectionStateChange: ((state: RTCPeerConnectionState) => void) | null = null;

  /** Call this before createOffer or handleOffer */
  public setLocalStream(stream: MediaStream): void {
    this.localStream = stream;
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Trickle ICE: send candidates as they're discovered
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        signalingService.send("ice", candidate.toJSON());
      }
    };

    // Deliver the remote stream to the UI
    pc.ontrack = ({ streams }) => {
      if (streams[0] && this.onRemoteStream) {
        this.onRemoteStream(streams[0]);
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(pc.connectionState);
      }
    };

    // Add local tracks BEFORE creating an offer
    // (the SDP must contain media sections for the tracks to be negotiated)
    this.localStream?.getTracks().forEach(track => {
      pc.addTrack(track, this.localStream!);
    });

    return pc;
  }

  /** Caller side: create and send an offer */
  public async createOffer(): Promise<void> {
    this.pc = this.createPeerConnection();
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    signalingService.send("offer", { sdp: offer.sdp, type: offer.type });
  }

  /** Callee side: receive offer, create and send answer */
  public async handleOffer(sdp: string, type: RTCSdpType): Promise<void> {
    this.pc = this.createPeerConnection();
    await this.pc.setRemoteDescription({ sdp, type });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    signalingService.send("answer", { sdp: answer.sdp, type: answer.type });
  }

  /** Both sides: apply the answer when received */
  public async handleAnswer(sdp: string, type: RTCSdpType): Promise<void> {
    await this.pc?.setRemoteDescription({ sdp, type });
  }

  /** Both sides: apply ICE candidates as they arrive */
  public async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc?.addIceCandidate(candidate);
  }

  /** Hang up and clean up */
  public hangUp(): void {
    this.localStream?.getTracks().forEach(t => t.stop());
    this.pc?.close();
    this.pc = null;
    this.localStream = null;
    signalingService.send("leave", {});
  }
}

export const webrtcService = new WebRTCService();
```

> [!TIP]
> **🔗 Phase 2 → Phase 3 Bridge: `signalingService` is Already Built**
>
> Notice that `WebRTCService` imports and calls `signalingService.send(...)` directly — the same singleton you built in Phase 2. You don't need a new WebSocket connection for WebRTC signaling; the existing one carries offers, answers, ICE candidates, and pubkeys through the same message envelope format.
>
> This is the payoff of the versioned `Envelope` design from Phase 2, Step 1: the `type` field routes messages to the right handler (`"offer"` → `handleOffer`, `"ice"` → `handleIceCandidate`) without the server needing to understand the payload at all.

> [!NOTE]
> **📚 Why `addTrack` Must Happen Before `createOffer`**
>
> SDP describes the media sections of the connection (audio track, video track). If you call `createOffer()` before adding tracks, the resulting SDP has no media sections — the remote peer receives it and creates a `recvonly` or empty connection. The call appears to connect but no video flows.
>
> The correct sequence is always: `addTrack` → `createOffer` → `setLocalDescription`.

### 2.2 Wire signaling messages to `WebRTCService`

In your call component's `useEffect`, subscribe to signaling envelopes and dispatch to `WebRTCService`:

```ts
const unsubscribe = signalingService.onMessage(async (env: Envelope) => {
  const p = env.payload as Record<string, any>;
  
  switch (env.type) {
    case "offer":
      await webrtcService.handleOffer(p.sdp, p.type);
      break;
    case "answer":
      await webrtcService.handleAnswer(p.sdp, p.type);
      break;
    case "ice":
      await webrtcService.handleIceCandidate(p);
      break;
    case "leave":
      webrtcService.hangUp();
      break;
  }
});
```

> [!NOTE]
> **📚 ICE Candidate Timing & `addIceCandidate` Ordering**
>
> ICE candidates can arrive via signaling *before* `setRemoteDescription` is called (because the remote peer started gathering immediately when they set their local description). If you call `addIceCandidate` before `setRemoteDescription`, the browser throws "Cannot add ICE candidate without an established remote description".
>
> **Solution**: Queue incoming ICE candidates and apply them only after `setRemoteDescription` has been called. For Phase 3, the timing usually works out — but be aware this is a real race condition. The robust solution (queuing) is worth implementing if you see sporadic ICE failures.

> [!TIP]
> **🔗 Phase 2 → Phase 3 Bridge: The Same Race Condition, Different Language**
>
> In Phase 2, you solved a nearly identical problem in Go: a slow or dead peer must not block the Hub. Your solution was a non-blocking channel send — `select { case peer.Send <- b: default: }` — which *drops* the message rather than waiting.
>
> Here in Phase 3, you face the inverse: *withhold* ICE candidates rather than drop them. The solution is a JavaScript array acting as a queue, flushed after `setRemoteDescription` completes. Same root cause (a timing dependency between two async operations), different idiomatic fix.
>
> When you find yourself reaching for a queue in async JS, ask: is there a Go channel analogue here?

---

## Step 3 — Remote Stream Rendering

Display the peer video alongside your local preview:

```tsx
const remoteVideoRef = useRef<HTMLVideoElement>(null);

useEffect(() => {
  webrtcService.onRemoteStream = (stream) => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = stream;
    }
  };

  webrtcService.onConnectionStateChange = (state) => {
    setConnectionState(state); // Local state for UI display
    if (state === "failed") {
      // A failed connection cannot be reused — must create a new RTCPeerConnection
      handleHangUp();
    }
  };
}, []);

// In JSX:
<video ref={remoteVideoRef} autoPlay playsInline />
<span>{connectionState}</span>
```

> [!NOTE]
> **📚 `connectionState === "failed"` is Terminal**
>
> When `connectionState` reaches `"failed"`, the `RTCPeerConnection` object is permanently broken. It cannot recover on its own. Unlike `"disconnected"` (which can heal spontaneously if the network returns), `"failed"` means ICE has given up. You must:
> 1. Tear down the failed connection
> 2. Signal a hang-up to the peer
> 3. Create a completely new `RTCPeerConnection` if the user wants to retry
>
> Not handling `"failed"` means the call UI appears stalled with no video and no error displayed.

> [!TIP]
> **🔗 Phase 2 → Phase 3 Bridge: Two State Machines, Same Pattern**
>
> In Phase 2, the browser `WebSocket` had a 4-state lifecycle (`CONNECTING → OPEN → CLOSING → CLOSED`). You wrote `intentionallyDisconnected` to distinguish a deliberate close from an unexpected one, and used the `onclose` event to drive reconnection logic.
>
> `RTCPeerConnection` has *three* parallel state machines (`signalingState`, `iceConnectionState`, `connectionState`), and the same principle applies: `"disconnected"` is transient and may self-heal, `"failed"` is terminal and requires explicit cleanup. The same pattern of "observe state transitions to drive UI and recovery logic" is the skill — just applied to a more complex object.

---

## Step 4 — Call Controls

Implement mute, disable camera, and hang-up. These operate on the local `MediaStreamTrack` objects:

```ts
// Mute mic (track still exists, just sends silence)
localStream.getAudioTracks().forEach(t => t.enabled = !t.enabled);

// Disable camera (track still exists, sends black frames)
localStream.getVideoTracks().forEach(t => t.enabled = !t.enabled);

// Hang up
webrtcService.hangUp();
```

> [!NOTE]
> **`track.enabled = false` vs. `track.stop()`**
>
> `track.enabled = false` pauses the track — the sender continues sending (silence / black frames) without re-negotiating the connection. This is reversible.
>
> `track.stop()` permanently ends the track. The camera light turns off. To re-enable the camera after `stop()`, you must call `getUserMedia` again and replace the track in the `RTCPeerConnection` via `RTCRtpSender.replaceTrack()`.
>
> For a "mute" button, always use `track.enabled`. For hang-up, always use `track.stop()` so the OS knows you're done with the hardware.

---

## Step 5 — TURN Server Setup (Development)

For local development and testing, deploy `coturn` to confirm your ICE fallback path works.

### 5.1 Install and run coturn (macOS)

```bash
brew install coturn
turnserver -a -v -n --no-dtls --no-tls -u testuser:testpass -r testRealm
```

### 5.2 Update ICE server config in `WebRTCService`

```ts
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: "turn:127.0.0.1:3478",
    username: "testuser",
    credential: "testpass",
  },
];
```

### 5.3 Force TURN-only to verify relay works

To verify your TURN config without depending on P2P succeeding, temporarily filter candidates:

```ts
// In RTCPeerConnection config — forces relay-only
pc.onicecandidate = ({ candidate }) => {
  // Only send relay candidates to test TURN
  if (candidate && candidate.type === "relay") {
    signalingService.send("ice", candidate.toJSON());
  }
};
```

Remove this filter after verification — it's for testing only.

> [!IMPORTANT]
> **Production TURN is mandatory.** Without it, users behind symmetric NATs (common in corporate environments) will fail to connect. Plan TURN deployment (`coturn` on your VPS, or a managed service like Twilio STUN/TURN) alongside the signaling server before any real-world usage.

---

## File Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/services/media.ts` | **NEW** | `getUserMedia` wrapper with error handling |
| `src/services/webrtc.ts` | **NEW** | `WebRTCService` class wrapping `RTCPeerConnection` |
| `src/App.tsx` or a new call component | **MODIFY** | Wire `WebRTCService` to signaling and render remote video |
| ICE server config | **MODIFY** | Add TURN credentials once coturn is running |

---

## Verification Plan

### Automated Tests

Phase 3 has limited automated test coverage — WebRTC requires real media devices. Focus on:

```bash
# TypeScript compilation (catches type errors in WebRTCService)
pnpm run lint

# If you add pure unit tests for state machine logic:
pnpm test
```

### Manual Verification

> [!NOTE]
> All of the below steps require running both the signaling server and two Tauri app instances simultaneously: `make dev-server` in one terminal, `make dev-app` in another.

1. **Basic call**:
   - Instance A creates a room (gets a token), Instance B joins with the token
   - Instance A clicks "Call" → `createOffer` fires, offer flows via signaling to Instance B
   - Instance B auto-answers → `handleOffer` + `handleAnswer` fire
   - Both instances show live video of the other peer
   - Verify in browser devtools: `RTCPeerConnection.connectionState === "connected"`

2. **ICE candidate verification**:
   - Open browser devtools → `chrome://webrtc-internals` (or equivalent in Tauri's webview)
   - Confirm `srflx` or `host` candidates were used (STUN path connected)

3. **TURN relay verification**:
   - Apply the relay-only filter above
   - Confirm call succeeds (proves TURN path works)
   - Remove filter after test

4. **Mute / disable camera / hang-up**:
   - Click mute → peer's audio goes silent
   - Click disable camera → peer sees black video
   - Click hang-up → both peers return to lobby, `leave` message visible in logs

5. **DTLS/SRTP confirmation**:
   - In `chrome://webrtc-internals`: confirm DTLS handshake succeeded and SRTP is active (media is encrypted at the SRTP layer — custom E2E comes in Phase 5)

6. **Webview compatibility check** (critical — do this early):
   - On macOS: confirm `RTCRtpScriptTransform` is available (`typeof RTCRtpScriptTransform !== "undefined"`)
   - This is required for Phase 5. If unavailable, report and plan the fallback path now.

---

## Estimated Time: 3–5 days

### Common Blockers

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `signalingState` is `"have-local-offer"` but never progresses | Answer never received or `setRemoteDescription` not called | Check signaling logs; verify the `answer` message is received and handled |
| ICE stays in `"checking"` forever | No viable candidate pair | Add TURN; check firewall rules |
| Remote video is black but audio works | Tracks added after `createOffer` | Ensure `addTrack` happens before `createOffer` |
| `addIceCandidate` throws | Called before `setRemoteDescription` | Queue candidates; apply after remote description is set |
| `getUserMedia` fails | Tauri missing entitlement or camera in use | Check `src-tauri/tauri.conf.json` permissions; check if camera is used by another app |

---

## Understanding Check

> [!IMPORTANT]
> Answer these **without looking** before advancing to Phase 4. They test synthesis, not recall.

1. **Offer/answer asymmetry**: Why does the *callee* create the answer rather than the caller? What would happen to the `signalingState` machine if both peers called `createOffer()` simultaneously without coordinating who is caller and callee?

2. **TURN necessity**: A peer is behind a symmetric NAT. Explain specifically *why* a STUN-derived `srflx` candidate is useless to the remote peer in this scenario, and what the relay candidate solves.

3. **`addTrack` ordering**: You call `createOffer()` first, then `addTrack()`. The remote peer receives the offer and creates an answer. Both sides report `connectionState === "connected"`. Why is there still no video?

4. **`disconnected` vs. `failed`**: A user's laptop briefly loses Wi-Fi for 3 seconds and reconnects. Which `connectionState` transitions would you observe, and would the call recover automatically or require user action?

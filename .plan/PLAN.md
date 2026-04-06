# Implementation Plan: Privacy-Focused P2P Video Chat

A detailed, step-by-step roadmap to build the application described in [GOAL.md](file:///Users/semen/_dev/_pet/priv_chat/GOAL.md).

> [!IMPORTANT]
> Each phase ends with concrete **verification criteria**. Do not advance to the next phase until every criterion is met.

---

## Phase 1: Project Scaffolding & Dev Environment

**Goal:** Get both projects (Tauri desktop app + signaling server) building and running locally.

### Learning Objectives
- Understand how Tauri structures a monorepo (Rust backend + web frontend sharing a process)
- Run a Go module from scratch and understand what `go mod init` and `go get` do
- Understand why a `rust-toolchain.toml` exists (reproducible, pinned toolchains in CI)
- Get comfortable with the `make` / `justfile` approach to unified dev commands

### Key Concepts
- **Go modules**: `go.mod` is the Go equivalent of `package.json` — it declares the module path and dependencies
- **Tauri architecture**: a Rust process owns the window; a Node-built web bundle runs inside it — two different languages, one binary
- **`internal` package**: Go's way to prevent external packages from importing your private types

### Steps

1. **Initialize the Tauri v2 app**
   - `npm create tauri-app@latest` → choose TypeScript + React (or Solid).
   - Verify `cargo tauri dev` opens a window with the default starter page.
   - Pin Tauri CLI + Rust toolchain versions in `rust-toolchain.toml`.

2. **Initialize the signaling server**
   - Create a `server/` directory at project root.
   - Choose Go or Node based on comfort; for this plan we assume **Go + `gorilla/websocket`**.
   - `go mod init privchat-signal` → add `gorilla/websocket`.
   - Create a minimal `main.go` with a `/ws` endpoint that upgrades to WebSocket and echoes messages.

3. **Monorepo housekeeping**
   - Set up a top-level `Makefile` (or `justfile`) with targets: `dev-app`, `dev-server`, `lint`, `test`.
   - Add `.editorconfig`, `.gitignore`, and basic CI config (GitHub Actions) that builds both projects.

### Deliverables
```
priv_chat/
├── src-tauri/          # Rust backend
├── src/                # TS/React frontend
├── server/             # Go signaling server
├── Makefile
└── ...
```

### Verification
- [ ] `cargo tauri dev` opens the desktop window.
- [ ] `go run ./server` listens on `:8080/ws` and echoes a test WebSocket message (use `websocat` or a quick Node script).

### Estimated time: 1–2 days

---

## Phase 2: Signaling Server — Session Negotiation

**Goal:** Two Tauri app instances can discover each other through the signaling server and exchange arbitrary JSON messages (precursor to SDP/ICE).

### Learning Objectives
- Understand Go's CSP concurrency model: goroutines, channels, and why `gorilla/websocket` requires ReadPump/WritePump
- Understand `sync.RWMutex` — when to use read locks vs write locks
- Design a versioned binary protocol from scratch and understand why protocol versioning matters from day one
- Implement cryptographically secure random token generation and constant-time comparison
- Build a TypeScript service singleton with exponential backoff reconnection logic

### Key Concepts
- **ReadPump/WritePump pattern**: `gorilla/websocket` is not safe for concurrent writes — two goroutines per connection is the enforced pattern
- **`sync.RWMutex`**: many goroutines can read concurrently, but writes are exclusive
- **Non-blocking channel send** (`select { case ch <- v: default: }`): prevents a slow client from blocking the hub
- **Constant-time comparison** (`crypto/subtle`): prevents timing attacks on token validation
- **Exponential backoff**: `min(1000 * 2^attempt, 30000)ms` — avoids thundering-herd reconnects

### Steps

1. **Room/session model**
   - Design a simple in-memory room map: `map[roomID][]conn`.
   - Define a versioned JSON message envelope:
     ```json
     { "v": 1, "type": "join|offer|answer|ice|pubkey|leave", "room": "abc", "payload": {} }
     ```
   - Include protocol version `v` from the start to support backward-compatible evolution.

2. **Room authentication**
   - Room creation generates a unique invite token (cryptographically random, URL-safe).
   - `join` messages must include the invite token; the server rejects invalid tokens.
   - This prevents unauthorized room access and is required before public keys are exchanged over the signaling channel.

3. **Server-side routing**
   - On `join`: validate invite token, register the connection in the room (max 2 peers for now).
   - On `offer|answer|ice|pubkey`: forward the message to the other peer in the room.
   - On disconnect: clean up and notify the remaining peer.

4. **Client-side WebSocket service**
   - Create a `SignalingService` class/module in the Tauri frontend.
   - Methods: `connect(url)`, `joinRoom(id, token)`, `send(type, payload)`, `onMessage(callback)`.
   - Wire a minimal UI: text input for room ID + invite token, "Join" button, message log.

5. **Reconnection & heartbeat**
   - Add a ping/pong heartbeat (30s interval).
   - Client auto-reconnects with exponential backoff on disconnect.

### Verification
- [ ] Open two Tauri app instances, both join room `"test"` with a valid invite token.
- [ ] Joining with an invalid token is rejected by the server.
- [ ] Sending a JSON message from instance A appears in instance B's log and vice-versa.
- [ ] Killing the server and restarting it causes both clients to reconnect automatically.

### Estimated time: 2–3 days

---

## Phase 3: 1-on-1 WebRTC Video Call (Plain SRTP)

**Goal:** Establish a working peer-to-peer video call using the browser's `RTCPeerConnection` API, routed through the signaling server for SDP/ICE exchange. No custom E2E encryption yet.

### Learning Objectives

- Understand the WebRTC offer/answer model: what SDP encodes and why the ordering (`setLocalDescription` → signal → `setRemoteDescription`) is strict
- Understand ICE and why trickle ICE speeds up connection time
- Know when STUN is sufficient vs. when TURN is required (symmetric NAT, corporate firewalls)
- Read the `RTCPeerConnection` state machine: `iceConnectionState`, `connectionState`, `signalingState`
- Handle `getUserMedia` permission flows and stream lifecycle

### Key Concepts

- **SDP (Session Description Protocol)**: a text blob describing codecs, IP addresses, and ports — not a streaming format, a negotiation format
- **Trickle ICE**: candidates are sent as they're gathered, not all at once — reduces connection setup time
- **STUN vs. TURN**: STUN reveals your public IP; TURN relays media when P2P is impossible (~10–15% of real-world connections)
- **`ontrack` event**: how the remote media stream arrives at the receiver's `<video>` element

### Steps

1. **Camera & microphone access**
   - `navigator.mediaDevices.getUserMedia({ video: true, audio: true })`.
   - Render local stream in a `<video>` element (muted, mirrored).
   - Handle permission denied gracefully (show error UI).

2. **`RTCPeerConnection` setup**
   - Create a `WebRTCService` class wrapping `RTCPeerConnection`.
   - Use Google's public STUN server initially: `stun:stun.l.google.com:19302`.
   - Lifecycle:
     - **Caller** creates an offer → sends via signaling → **Callee** receives and sets remote description → creates answer → sends back.
     - Both sides trickle ICE candidates through the signaling channel.

3. **Remote stream rendering**
   - On `track` event, attach the remote `MediaStream` to a second `<video>` element.
   - Display connection state (connecting / connected / disconnected) in the UI.

4. **Call controls**
   - Buttons: mute mic, disable camera, hang up.
   - Hang up tears down the `RTCPeerConnection` and sends a `leave` message.

5. **TURN server setup**
   - Deploy a local `coturn` instance for development.
   - Configure ICE servers in `RTCPeerConnection` to include both STUN and TURN credentials.
   - For production, plan TURN deployment alongside the signaling server. Without TURN, a significant percentage of users behind symmetric NATs or corporate firewalls will be unable to connect.

### Key risks
- Tauri's webview (WebKit on macOS, WebView2 on Windows) must support `getUserMedia`. Tauri v2 enables this, but test early.
- WebKit (macOS) and WebView2 (Windows) have different WebRTC feature support — verify `RTCRtpScriptTransform` availability before Phase 5.

### Verification
- [ ] Two Tauri instances on the same LAN can video-call each other.
- [ ] Mute/disable camera/hangup all work without crashing.
- [ ] Chrome DevTools `chrome://webrtc-internals` (or equivalent) shows DTLS/SRTP active.
- [ ] Connection succeeds through the local TURN server when P2P is blocked.

### Estimated time: 3–5 days

---

## Phase 4: Anti-Screen-Capture (Native OS APIs via Tauri)

**Goal:** The video chat window is invisible to screen capture tools (OBS, PrintScreen, screenshot, Discord screen share).

> [!CAUTION]
> This is the project's unique selling point. Verify thoroughly on each target OS.

### Learning Objectives
- Discover Tauri v2's built-in `setContentProtected` API and understand what it wraps on each OS
- Understand Rust's `unsafe` block as a deliberate escape hatch from the ownership model — and why every `unsafe` requires a `// SAFETY:` comment
- Learn how the Tauri command bridge (`#[tauri::command]`) crosses the JS↔Rust boundary
- Understand OS-level windowing APIs: `SetWindowDisplayAffinity` (Win32) and `NSWindow.sharingType` (AppKit)
- Practice platform-conditional compilation with `#[cfg(target_os = "windows")]`

### Key Concepts
- **Tauri `setContentProtected`**: Tauri v2 provides a cross-platform API (`window.setContentProtected(true)` in JS, `.content_protected(true)` in Rust) that internally calls the OS-native protection. This is the **primary approach** — use it first, then consider manual FFI only if you need stronger control (e.g., `WDA_EXCLUDEFROMCAPTURE` vs. `WDA_MONITOR`)
- **`unsafe` in Rust**: calling FFI (foreign function interface) C/ObjC APIs bypasses Rust's safety checks — you become responsible for upholding the invariants manually
- **`windows-rs` / `objc2`**: Rust crates that provide safe(r) wrappers around Win32 and Objective-C runtime APIs
- **`#[cfg(target_os)]`**: compile-time platform branching — the code for Windows literally does not exist in the macOS binary

### Steps

1. **Cross-platform: Tauri built-in `setContentProtected` (primary approach)**
   - **Capability permission**: Add `core:window:allow-set-content-protected` to `src-tauri/capabilities/default.json`:
     ```json
     {
       "permissions": ["core:default", "opener:default", "core:window:allow-set-content-protected"]
     }
     ```
   - **Frontend call**: Use the Tauri JS API to enable protection at runtime:
     ```ts
     import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

     const appWindow = getCurrentWebviewWindow();
     await appWindow.setContentProtected(true);
     ```
   - **Alternative — Rust side at window build time**: Set protection in `lib.rs` or via `tauri.conf.json` window config. However, the JS runtime approach is preferred because it allows toggling protection on/off and reporting the result to the UI.
   - Internally, Tauri calls `SetWindowDisplayAffinity(WDA_MONITOR)` on Windows and `NSWindow.sharingType = .none` on macOS.

2. **Windows upgrade: `WDA_EXCLUDEFROMCAPTURE` (optional FFI for stronger protection)**
   - Tauri's built-in API uses `WDA_MONITOR` which shows a black window in captures. `WDA_EXCLUDEFROMCAPTURE` (Windows 10 2004+) goes further: the window is **completely absent** from captures.
   - If the stronger behavior is desired, add a Tauri command using manual FFI:
   - **`Cargo.toml` — platform-conditional dependency**:
     ```toml
     [target.'cfg(target_os = "windows")'.dependencies]
     windows = { version = "0.58", features = ["Win32_UI_WindowsAndMessaging", "Win32_Foundation"] }
     ```
   - **Tauri command**:
     ```rust
     #[tauri::command]
     fn enable_anti_capture(window: tauri::Window) -> Result<(), String> {
         #[cfg(target_os = "windows")]
         {
             use windows::Win32::UI::WindowsAndMessaging::*;
             use windows::Win32::Foundation::HWND;
             let hwnd = window.hwnd().map_err(|e| e.to_string())?;
             // SAFETY: hwnd is a valid window handle obtained from Tauri.
             // SetWindowDisplayAffinity is safe to call with a valid HWND and a defined affinity constant.
             unsafe {
                 SetWindowDisplayAffinity(HWND(hwnd.0), WDA_EXCLUDEFROMCAPTURE)
                     .map_err(|e| e.to_string())?;
             }
         }
         Ok(())
     }
     ```
   - Register the command in `tauri::Builder` and invoke from JS after `setContentProtected` as an upgrade attempt.

3. **macOS: verify `setContentProtected` behavior**
   - Tauri's `setContentProtected(true)` internally sets `NSWindow.sharingType = .none`, which requires macOS 12.0+.
   - **No manual FFI is needed** unless custom behavior beyond `.none` is required. If manual access is ever needed, the `NSWindow` pointer is obtained via:
     ```rust
     #[cfg(target_os = "macos")]
     {
         use objc2_app_kit::NSWindowSharingType;
         // window.ns_window() returns a raw *mut c_void pointer to the NSWindow
         let ns_window = window.ns_window().map_err(|e| e.to_string())?;
         // Cast and call setSharingType: via objc2 runtime
     }
     ```
   - **`Cargo.toml` — platform-conditional dependency** (only needed if manual FFI route is taken):
     ```toml
     [target.'cfg(target_os = "macos")'.dependencies]
     objc2 = "0.5"
     objc2-app-kit = { version = "0.2", features = ["NSWindow"] }
     objc2-foundation = "0.2"
     ```
   - **Graceful degradation on macOS < 12.0**: The JS call `setContentProtected(true)` will silently succeed but have no effect. Detect this condition and show a persistent warning banner (see Step 5).

4. **Linux: warning-only for MVP**
   - **X11**: No OS-level capture protection exists. `setContentProtected` has no effect.
   - **Wayland**: Compositor-level exclusion (`zwlr_screencopy_manager_v1`) exists on some compositors (Sway, KDE 6+) but is not exposed by Tauri. Defer to Phase 7 or a future enhancement.
   - **MVP scope**: Detect the display server and show a persistent warning banner: "Screen capture protection is unavailable on Linux. Your call is still end-to-end encrypted."
   - **Watermarking** (semi-transparent per-user overlay) is deferred to Phase 7, Step 2 as a Linux fallback deterrent.

5. **Frontend integration & degradation UX**
   - Call `setContentProtected(true)` when entering a call (not on `DOMContentLoaded` — protection is only needed during active calls).
   - Call `setContentProtected(false)` when the call ends (allows normal screenshots of the lobby UI).
   - **Shield icon states**:
     - 🛡️ Green shield: protection active (Windows/macOS confirmed).
     - ⚠️ Yellow shield: protection unavailable (Linux, or macOS < 12.0). Shows a persistent banner explaining why.
     - The shield icon is always visible during a call — do not hide it.
   - If the optional `WDA_EXCLUDEFROMCAPTURE` upgrade (Step 2) fails, fall back to the built-in `WDA_MONITOR` result without user-facing error.

6. **Optional: detect recording software**
   - Tauri command that scans running processes for known recorders (OBS, Bandicam, etc.).
   - Show a warning if detected. This is easily bypassed — treat as a soft deterrent only.

### File Summary

| File | Action | Purpose |
|------|--------|---------|
| `src-tauri/capabilities/default.json` | **MODIFY** | Add `core:window:allow-set-content-protected` permission |
| `src-tauri/Cargo.toml` | **MODIFY** | Add platform-conditional deps (`windows`, optionally `objc2`) |
| `src-tauri/src/lib.rs` | **MODIFY** | Add `enable_anti_capture` command (Windows FFI upgrade), register in builder |
| `src/services/anti-capture.ts` (or similar) | **NEW** | Wrapper calling `setContentProtected` + optional `invoke("enable_anti_capture")` |
| Call component (e.g., `src/App.tsx`) | **MODIFY** | Wire anti-capture on call start/end, render shield icon + platform warning |

### Common Blockers

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `setContentProtected` call throws permission error | Missing capability permission | Add `core:window:allow-set-content-protected` to `capabilities/default.json` |
| OBS still captures window on Windows | Using `WDA_MONITOR` (Tauri default) which shows black — but some tools bypass it | Upgrade to `WDA_EXCLUDEFROMCAPTURE` via manual FFI (Step 2) |
| `window.hwnd()` or `window.ns_window()` not found | Wrong Tauri import or version | Ensure `tauri = "2"` and using `tauri::Window` from `#[tauri::command]` parameter |
| macOS screenshot still captures content | macOS < 12.0, or `sharingType` not supported by the window type | Add version detection; show warning banner |
| `windows` crate feature compilation error | Missing feature gate in `Cargo.toml` | Ensure `features = ["Win32_UI_WindowsAndMessaging", "Win32_Foundation"]` |

### Verification
- [ ] **Windows**: Open OBS → add "Window Capture" or "Display Capture" → the app window is black or absent.
- [ ] **Windows**: `Win+Shift+S` (Snipping Tool) cannot capture the window content.
- [ ] **macOS**: `Cmd+Shift+5` screenshot/recording shows a black/blank area where the app is.
- [ ] **macOS**: QuickTime screen recording omits the window.
- [ ] **Linux**: Warning banner is displayed on X11/Wayland sessions during a call.
- [ ] **All platforms**: Shield icon shows correct state (green on Win/Mac, yellow on Linux).
- [ ] **All platforms**: Protection toggles off when call ends (lobby screenshots work normally).

### Estimated time: 3–4 days

---

## Phase 5: End-to-End Encryption via Insertable Streams

**Goal:** Even if an attacker (or future SFU) intercepts WebRTC media packets, they see only encrypted noise. Only the two call participants can decrypt.

### Learning Objectives
- Understand the Diffie-Hellman key exchange and why neither party ever sends the shared secret over the wire
- Understand HKDF: why you can't use a raw DH output as an encryption key and what a KDF does
- Understand AES-GCM: authenticated encryption, what the IV is for, and why IV reuse is catastrophic
- Implement `RTCRtpScriptTransform` and understand why frame encryption must run in a Worker
- Implement SAS fingerprint verification and understand why it defeats MITM key substitution

### Key Concepts
- **X25519 ECDH**: both parties independently derive the same shared secret; eavesdroppers cannot compute it from public keys alone
- **HKDF (RFC 5869)**: extract → expand; turns a DH output into a uniform, safely-sized key
- **AES-GCM IV**: must be unique per encryption with the same key — `crypto.getRandomValues(new Uint8Array(12))` every frame
- **`RTCRtpScriptTransform`**: intercepts encoded frames in a Worker before they reach the SRTP layer
- **SAS**: a human-verified fingerprint of the shared secret that defeats a MITM who substitutes public keys

### Steps

1. **Rust-side key derivation**
   - Add crates: `x25519-dalek`, `hkdf`, `rand`.
   - Tauri commands:
     - `generate_keypair()` → returns `{ publicKey: base64 }`, stores private key in memory (never exposed to JS).
     - `derive_shared_secret(remotePublicKey: base64)` → X25519 DH + HKDF-SHA256 → returns the derived AES-256-GCM key as a `CryptoKey`-importable raw byte array.
   - The symmetric key is exported to JS **once** at call start. Per-frame IPC (JS→Rust→JS) would be too slow for 30/60fps video due to JSON serialization overhead.

2. **Key exchange over signaling**
   - After joining a room and before creating the `RTCPeerConnection`:
     - Call `generate_keypair()`.
     - Send the public key to the peer via a signaling message `{ "v": 1, "type": "pubkey", "payload": "<base64>" }`.
     - On receiving the peer's public key, call `derive_shared_secret(remotePubKey)`.
   - Both sides now hold the same symmetric key without the signaling server ever seeing the private keys.

3. **Key fingerprint verification (SAS)**
   - After key derivation, both sides compute a Short Authentication String (SAS) from the shared secret (e.g., first 6 bytes → 4-word mnemonic or 6-digit code).
   - Display the SAS prominently in the call UI. Users verify it matches by reading it aloud.
   - This defends against a MITM signaling server substituting public keys.
   - Mark the call as "Verified" only after the user confirms the SAS matches.

4. **WebRTC Encoded Transform (frame encryption in JS)**
   - Import the derived key into `SubtleCrypto` as a `CryptoKey` (AES-GCM).
   - Use `RTCRtpScriptTransform` (current spec) — **not** the legacy `createEncodedStreams` API.
   - On the sender side, inside the transform worker:
     ```ts
     // In the RTCRtpScriptTransform worker
     async function encryptFrame(encodedFrame, controller) {
       const iv = crypto.getRandomValues(new Uint8Array(12));
       const encrypted = await crypto.subtle.encrypt(
         { name: 'AES-GCM', iv },
         cryptoKey,
         encodedFrame.data
       );
       // Prepend IV to ciphertext
       const result = new Uint8Array(iv.length + encrypted.byteLength);
       result.set(iv);
       result.set(new Uint8Array(encrypted), iv.length);
       encodedFrame.data = result.buffer;
       controller.enqueue(encodedFrame);
     }
     ```
   - On the receiver side: extract the 12-byte IV prefix, decrypt the remainder.
   - **Trade-off accepted**: The symmetric key lives in JS memory during the call. This is acceptable — the key is ephemeral (per-call), and an attacker with JS memory access already has access to decoded video frames.

5. **Key rotation (stretch goal)**
   - Implement a simple ratchet: after N frames (e.g., every 256 frames), derive a new key from the current one using HKDF.
   - This limits the window of compromise if a key is ever leaked.

### Verification
- [ ] Capture raw RTP packets with Wireshark → media payloads are opaque (cannot be decoded by ffmpeg or any standard decoder).
- [ ] Both peers see clear video/audio — confirming decryption works.
- [ ] Deliberately using the wrong key on one side results in garbled/black video (not a crash).
- [ ] SAS fingerprint is displayed and matches on both clients.

### Estimated time: 5–7 days

---

## Phase 6: Group Calls via SFU (Optional)

**Goal:** Scale beyond 2 participants using a Selective Forwarding Unit that routes encrypted frames without decrypting them.

### Learning Objectives
- Understand what an SFU is and how it differs from a P2P mesh and an MCU
- Understand why an SFU can forward E2E-encrypted frames it cannot decrypt (it just sees opaque bytes)
- Understand the complexity of multi-party key management vs. pairwise 1:1 keys

### Key Concepts
- **SFU (Selective Forwarding Unit)**: receives RTP streams from each participant, selectively forwards them to others — no transcoding
- **Pion**: Go's WebRTC library, allowing native WebRTC endpoints (not just a browser)
- **Group key vs. pairwise keys**: a single group AES key enables forwarding to all participants; pairwise keys require N×(N-1) derivations

### Steps

1. **Deploy the SFU**
   - Choose **Pion** (Go) for consistency with the signaling server language.
   - Set up a minimal Pion-based SFU that:
     - Accepts WebRTC connections from clients.
     - Subscribes each client to every other client's tracks.
     - Forwards RTP packets as-is (no transcoding, no decryption).

2. **Update signaling for SFU topology**
   - Instead of exchanging SDP directly between peers, clients exchange SDP with the SFU.
   - The signaling server orchestrates: `client → signaling → SFU → signaling → client`.

3. **Multi-party key exchange**
   - Each participant generates a keypair and broadcasts their public key to all peers via signaling.
   - Each participant derives a per-peer shared secret. Alternatively, use a group key approach:
     - One participant (the "leader") generates a symmetric group key, encrypts it with each peer's public key, and distributes it.
   - All participants encrypt with the same group key so the SFU can forward frames to everyone.

4. **Client-side multi-stream rendering**
   - Render N remote video streams in a dynamic grid layout.
   - Implement "dominant speaker detection" (loudest audio) to highlight the active speaker.

### Key risks
- Group key management is significantly more complex than 1:1. Consider limiting group size to 4–6 for MVP.
- SFU adds infrastructure cost and a point of failure.

### Verification
- [ ] 3+ participants in a call; all see and hear each other clearly.
- [ ] Wireshark on the SFU's network interface shows only encrypted payloads.
- [ ] A participant leaving/joining mid-call doesn't break the remaining streams.

### Estimated time: 5–7 days

---

## Phase 7: Polish, UI/UX & Packaging

**Goal:** Production-ready application with polished UX, security indicators, and distributable binaries.

### Learning Objectives
- Understand how Tauri packages Rust + web assets into platform-native installers
- Understand code signing and notarisation (Apple) / Authenticode (Windows) and *why* they are required for distribution
- Write a threat model: articulate explicitly what the application protects against and what it does not

### Key Concepts
- **`cargo tauri build`**: bundles the Rust binary + web assets → `.dmg`, `.msi`, `.AppImage`
- **Code signing**: proves the binary came from a specific publisher and wasn't tampered with post-build
- **Threat model**: a concise document listing assets, threats, and mitigations — the output of security thinking, not an afterthought

### Steps

1. **Security indicators**
   - Green padlock/shield icon when E2E encryption is active.
   - Warning badge if anti-capture protection failed to initialize.
   - SAS verification status indicator ("Verified" / "Unverified") — the SAS mechanism itself is implemented in Phase 5.

2. **Visual watermarking (Linux fallback)**
   - Overlay a semi-transparent per-user watermark (username + timestamp) on the video canvas.
   - Acts as a deterrent for physical photography of the screen.

3. **UI polish**
   - Dark theme, responsive layout, call timer, connection quality indicator.
   - Smooth transitions between lobby → in-call → ended states.
   - Accessible keyboard navigation.

4. **Packaging & distribution**
   - `cargo tauri build` → `.exe`/`.msi` (Windows), `.dmg` (macOS), `.AppImage` (Linux).
   - Code-sign binaries (Apple notarization, Windows Authenticode).
   - Set up auto-update via Tauri's built-in updater plugin.

5. **Documentation**
   - README with build instructions, architecture overview, and security model description.
   - Threat model document outlining what the app protects against and what it doesn't.

### Verification
- [ ] Clean install on a fresh Windows/macOS/Linux machine → app launches and connects.
- [ ] All security indicators display correctly in each state (encrypted, unprotected, etc.).
- [ ] Auto-update mechanism works (push a test update and verify the client picks it up).

### Estimated time: 5–7 days

---

## Summary Timeline

| Phase | Description | Est. Days |
|-------|-------------|-----------|
| 1 | Scaffolding & dev environment | 1–2 |
| 2 | Signaling server | 2–3 |
| 3 | 1-on-1 WebRTC video call | 3–5 |
| 4 | Anti-screen-capture (native OS) | 3–4 |
| 5 | E2E encryption (Insertable Streams) | 5–7 |
| 6 | Group calls via SFU (optional) | 5–7 |
| 7 | Polish, UX & packaging | 5–7 |
| **Total** | | **~24–35 days** |

> [!NOTE]
> Phase 6 (SFU/group calls) is optional and can be deferred. Without it, the core product (secure 1:1 video chat with anti-capture) is achievable in ~14–21 days.

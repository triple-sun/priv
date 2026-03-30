
## Core Architecture

### 1. Desktop Framework (Cross-platform Native)

**Tauri** has been chosen as the core framework because it provides the smallest attack surface, compiles to a lightweight native binary, and grants direct access to native OS APIs via Rust which is absolutely critical for anti-capture mechanisms.

---

### 2. WebRTC & E2E Encryption

- **WebRTC** is the standard for peer-to-peer video. Media streams are already encrypted (SRTP), but the encryption keys are managed by the server in a typical SFU setup.
- For **true E2E encryption**, use the [Insertable Streams API (WebRTC Encoded Transform)](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_Encoded_Transforms) — lets you encrypt/decrypt each video frame before it leaves/arrives the peer connection.
- **Key exchange**: Use [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) or a simplified X25519 + HKDF handshake. Rust crates: `x25519-dalek`, `aes-gcm`, `hkdf`.

> [!IMPORTANT]
> **Frame encryption path decision**: Per-frame IPC (JS→Rust→JS via `invoke`) is too slow for 30/60fps video due to JSON serialization overhead. The chosen approach is:
> - **Key derivation in Rust**: X25519 DH + HKDF runs in Rust. The derived AES-256-GCM key is exported to JS **once** at call start via `invoke`.
> - **Frame encryption in JS**: Use the `SubtleCrypto` (Web Crypto API) for per-frame AES-GCM encryption/decryption inside the Encoded Transform worker.
> - **Trade-off**: The symmetric key lives in JS memory during the call. This is acceptable — the key is ephemeral (per-call), and an attacker with JS memory access already has access to the decoded video frames anyway.

**Signaling server**: WebSocket server in Go for session negotiation. No media passes through it.

**SFU (optional, for group calls)**: [Pion](https://github.com/pion/webrtc) (Go). With insertable streams, the SFU forwards encrypted frames it cannot decrypt.

**NAT traversal**: STUN is used for initial connectivity. A **TURN server** (e.g., `coturn`) is required for production to handle symmetric NATs and corporate firewalls where P2P fails. Plan deployment alongside the signaling server.

---

### 3. Anti-Screen-Capture / Anti-Recording

**Layered approach:**

| Layer | Technique | How |
|-------|-----------|-----|
| **OS-level** | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on Windows | Prevents `BitBlt`, OBS, PrintScreen from capturing the window. **This is the strongest native protection.** |
| **OS-level** | macOS `sharingType = .none` on `NSWindow` | Excludes window from screen capture/recording APIs (macOS 12.0+) |
| **OS-level** | Linux/Wayland: compositor `zwlr_screencopy_manager_v1` deny | Request that the Wayland compositor excludes the window from screen copy. Only works on compositors that support the protocol (Sway, KDE 6+). |
| **OS-level** | Linux/X11: No reliable equivalent | X11 has no capture protection. Show a prominent warning and recommend Wayland. |
| **App-level** | Detect screen recording software | Check running processes for OBS, Bandicam, etc. Warn/block. Easily bypassed — soft deterrent only. |
| **App-level** | Visual watermarking (Linux fallback) | Semi-transparent per-user watermark (username + timestamp) overlaid on video canvas. Deters physical photography. |


**Implementation via Tauri:**
- Tauri plugins can call native OS APIs via Rust. You'd write a Rust plugin that calls `SetWindowDisplayAffinity` (Windows) and `NSWindow.sharingType` (macOS via `objc` crate).
- On Linux/Wayland, attempt compositor-level exclusion; on X11, fall back to watermarking + warning.

---

### 4. Signaling Security

> [!WARNING]
> The signaling channel carries public keys for E2E key exchange. Without authentication, a MITM can substitute keys.

- **Authentication**: Room join requires a shared invite token or passphrase (implemented alongside room creation, not deferred to polish).
- **Key fingerprint verification**: After key exchange, both peers compute and display a Short Authentication String (SAS) — a human-readable fingerprint derived from the shared secret. Users verify it out-of-band (e.g., read it aloud). This is a **security-critical** feature, not a UI nicety.
- **Message envelope versioning**: All signaling messages include a protocol version field to support backward-compatible evolution:
  ```json
  { "v": 1, "type": "join|offer|answer|ice|pubkey|leave", "room": "abc", "payload": {} }
  ```

---

### 5. Webview Compatibility

Tauri uses **WebKit** (macOS/Linux) and **WebView2/Chromium** (Windows). These have different WebRTC feature support:

| Feature | WebView2 (Win) | WebKit (macOS) | WebKitGTK (Linux) |
|---------|----------------|----------------|--------------------|
| `getUserMedia` | ✅ | ✅ | ✅ |
| `RTCPeerConnection` | ✅ | ✅ | ✅ |
| Encoded Transform (`RTCRtpScriptTransform`) | ✅ | ✅ (Safari 15.4+) | ⚠️ Check version |
| `createEncodedStreams` (legacy) | ✅ | ❌ | ❌ |

> [!IMPORTANT]
> Use `RTCRtpScriptTransform` (current spec) as the primary API. Feature-detect at runtime and fail gracefully with a user-facing error if unsupported. Do **not** rely on `createEncodedStreams`.

---

### 6. Suggested Stack

```
┌─────────────────────────────────────┐
│           Tauri App (Desktop)       │
│  ┌───────────┐  ┌────────────────┐  │
│  │ Frontend  │  │  Rust Backend  │  │
│  │ TS/React  │  │  - Anti-capture│  │
│  │  - WebRTC │  │  - Key derives │  │
│  │  - E2E via│  │  - OS APIs     │  │
│  │  SubtleC. │  │                │  │
│  └───────────┘  └────────────────┘  │
└─────────────────────────────────────┘
         │ WebSocket (signaling)
         ▼
┌─────────────────────────────────────┐
│     Signaling Server (Go)           │
│  - Session negotiation              │
│  - Room auth (invite token)         │
│  - NO access to media/keys          │
└─────────────────────────────────────┘
         │ (optional, group calls)
         ▼
┌─────────────────────────────────────┐
│     SFU - Pion (Go)                 │
│  - Forwards encrypted frames only   │
│  - Cannot decrypt media             │
└─────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│     TURN Server (coturn)            │
│  - NAT traversal relay              │
│  - Sees only encrypted traffic      │
└─────────────────────────────────────┘
```

### Key Libraries

| Concern | Library/Tool | Language |
|---------|-------------|----------|
| Desktop shell | [Tauri v2](https://v2.tauri.app/) | Rust + TS |
| WebRTC | Browser `RTCPeerConnection` API | TS |
| E2E frame encryption | `SubtleCrypto` (Web Crypto API) inside `RTCRtpScriptTransform` worker | TS |
| Key derivation | `x25519-dalek`, `hkdf` | Rust |
| Signaling | `gorilla/websocket` | Go |
| SFU | [Pion](https://github.com/pion/webrtc) | Go |
| NAT traversal | [coturn](https://github.com/coturn/coturn) | C (deployed as infra) |
| Anti-capture (Win) | `windows-rs` → `SetWindowDisplayAffinity` | Rust |
| Anti-capture (Mac) | `objc2` crate → `NSWindow.sharingType` | Rust |

---

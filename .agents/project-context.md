# Privacy Chat - Project Context for Agents

You are working on a privacy-focused, cross-platform desktop video chat application. The app uses standard WebRTC for media transport, layered with custom end-to-end frame encryption and native OS-level APIs to deter screen capturing.

## Current Phase

**`current_phase: 2`** — Signaling Server (Session Negotiation) — **COMPLETE**

See `.plan/PLAN.md` → Phase 2 for the spec summary. See `.plan/PHASE_2.md` for the detailed implementation guide.

**Next phase: 3** — 1-on-1 WebRTC Video Call (Plain SRTP). See `.plan/PHASE_3.md`.

---

## Learning Context

This project is a **deliberate learning exercise**. When helping with tasks, surface the relevant concept from `learning-guide.md` before coding.

### Learning Objectives by Phase

| Phase | What you learn |
|-------|---------------|
| **1 (done)** | Go module system, Tauri v2 project structure, monorepo tooling |
| **2 (done)** | Go concurrency (goroutines, channels, `sync.RWMutex`), WebSocket duplex streams, protocol design, crypto-random tokens, TypeScript service singletons |
| **3 (current)** | WebRTC offer/answer model (SDP), ICE/STUN/TURN, `RTCPeerConnection` state machine, trickle ICE, media tracks |
| **4** | Rust FFI (`unsafe`), OS-level APIs via `windows-rs` / `objc2`, Tauri command bridge |
| **5** | X25519 Diffie-Hellman, HKDF, AES-GCM, `RTCRtpScriptTransform`, Web Crypto API, SAS fingerprinting |
| **6** | SFU architecture, Pion WebRTC (Go), group key exchange |
| **7** | App packaging, code signing, auto-update, threat modelling |

### Current Learning Focus (Phase 3)

The key concepts to understand before and during Phase 3:
- **SDP (Session Description Protocol)**: what it encodes, why offer/answer ordering matters
- **ICE (Interactive Connectivity Establishment)**: how candidates are gathered & exchanged (trickle vs. full)
- **STUN vs. TURN**: what each does and when TURN is strictly required
- **`RTCPeerConnection` state machine**: `iceConnectionState`, `connectionState`, `signalingState`
- **Media tracks**: `getUserMedia`, `addTrack`, `ontrack` event

---

## Repository Layout

```
priv_chat/
├── src/           # React + TypeScript frontend (Biome-formatted)
├── src-tauri/     # Tauri v2 Rust backend (Clippy-linted)
├── server/        # Go signaling server (gorilla/websocket)
├── .plan/         # Phased implementation plans + concept guides
├── .agents/       # Agent instructions, rules, workflows & learning guide
├── .github/       # CI workflows
└── Makefile       # Dev/lint/test targets
```

## Core Architecture
- **Desktop Framework**: Tauri v2 — minimal attack surface, lightweight native binary, direct access to OS APIs via Rust.
- **Frontend**: TypeScript + React, using `RTCRtpScriptTransform` for frame-level encryption via `SubtleCrypto`. Strict Biome formatting.
- **Backend / Desktop OS Layer**: Rust handles key derivation (`x25519-dalek`, `hkdf`) and OS-level features: anti-screen-capture APIs (Windows `SetWindowDisplayAffinity`, macOS `NSWindow.sharingType`). Frame encryption runs in JS via `SubtleCrypto` — Rust exports the derived key once per call.
- **Signaling Server**: Standalone Go server using `gorilla/websocket`. Handles SDP/ICE relay and room auth via invite tokens. No media decryption. Versioned message protocol (`v` field).
- **SFU (Optional)**: `Pion` (Go) for group calls, forwarding fully encrypted frames.
- **NAT Traversal**: STUN + TURN (`coturn`) for production.

## Key Constraints & Security Focus
- **Anti-Screen-Capture**: Highest priority. OS-level APIs from Rust. Linux/X11 has no reliable protection — uses watermarking + warning as fallback.
- **End-to-End Encryption**: Key derivation in Rust (X25519 DH + HKDF). Derived symmetric key exported to JS for per-frame AES-GCM encryption via `SubtleCrypto` inside `RTCRtpScriptTransform` worker. Private keys never exposed to JS.
- **Key Authentication**: SAS (Short Authentication String) fingerprint verification defends against MITM on the signaling channel.
- **Room Security**: Invite token required to join a room. Unauthenticated access is rejected.

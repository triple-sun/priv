# Security Checklist for Agents

> [!CAUTION]
> Review this checklist before submitting ANY code change that touches crypto, signaling, key material, or OS-level APIs.

## Key Material
- [ ] Private keys (X25519) never leave Rust memory. They are never serialized, logged, or returned to JS.
- [ ] The derived symmetric key is exported to JS **only once** per call session — not per frame.
- [ ] Ephemeral keys are zeroed/dropped after the call ends.
- [ ] No key material appears in `console.log`, `tracing::info!`, `log.Println`, or any log output at any level.

## Signaling Channel
- [ ] The signaling server never inspects or logs message `payload` contents (which may contain public keys or SDP).
- [ ] Invite tokens are cryptographically random (≥128 bits) and URL-safe.
- [ ] Token validation uses constant-time comparison to prevent timing attacks.
- [ ] Invalid tokens result in immediate WebSocket close — no partial room state is leaked.

## Frame Encryption
- [ ] Every encrypted frame uses a fresh random 12-byte IV (never reuse IVs with AES-GCM).
- [ ] Decryption failures produce a black/silent frame — never a crash or error leak to the peer.
- [ ] The `RTCRtpScriptTransform` worker does not expose `CryptoKey` to the main thread.

## Anti-Screen-Capture
- [ ] `SetWindowDisplayAffinity` (Windows) / `NSWindow.sharingType = .none` (macOS) is called before any video frame is rendered.
- [ ] All `unsafe` blocks have a `// SAFETY:` comment explaining why they are sound.
- [ ] Linux/X11 fallback shows a visible warning to the user — does not silently skip protection.

## General
- [ ] No sensitive data in error messages returned to the frontend (no stack traces, no internal paths).
- [ ] WebSocket connections use `wss://` in production config.
- [ ] CORS / Origin validation is enforced on WebSocket upgrade.

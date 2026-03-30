# Learning Guide: Technology Stack Concepts

This is the canonical concept reference for the technologies used in this project. It is intended for the developer and for AI agents to read before implementing tasks. Each section follows the same structure: **What it is → Mental model → Common pitfall → Where it appears in this project**.

---

## 1. Go

### Goroutines vs. Threads

**What it is**: A goroutine is a lightweight, cooperatively-scheduled function that runs concurrently. The Go runtime multiplexes thousands of goroutines onto a small pool of OS threads.

**Mental model**: Think of goroutines as tasks on a to-do list managed by a smart scheduler, not OS-level threads that the kernel has to context-switch. Starting a goroutine with `go fn()` costs ~2 KB of stack — spawning 10,000 is routine.

**Common pitfall**: Assuming goroutines run in a deterministic order, or that `go fn()` blocks until `fn` completes. It doesn't — execution immediately continues to the next line.

**In this project**: Every WebSocket connection spawns exactly two goroutines: `ReadPump` and `WritePump`. This is the standard `gorilla/websocket` pattern.

---

### Channels

**What it is**: A typed, goroutine-safe pipe for passing values between goroutines. `chan T` is unbuffered (synchronous); `chan T` with a capacity is buffered (async up to that capacity).

**Mental model**: A channel is a safe mailbox. The sender drops a letter in; the receiver picks it up. If the mailbox is full (buffered) or the receiver isn't ready (unbuffered), the sender waits — this is how goroutines synchronise without locks.

**Common pitfall**: Sending to a closed channel panics. Always close a channel from the *sender* side, never the receiver. Use `select { case ch <- v: default: }` for a non-blocking send when the receiver might be slow or dead.

**In this project**: `Client.Send chan []byte` is a buffered channel (capacity 256). `WritePump` reads from it. `ReadPump` and `Hub.RouteMessage` write to it. The non-blocking send pattern in `handleForward` prevents a slow client from blocking the entire hub.

---

### `sync.RWMutex`

**What it is**: A reader-writer mutex. Multiple goroutines may hold a read lock (`RLock`) simultaneously, but a write lock (`Lock`) is exclusive — it blocks until all readers release.

**Mental model**: Like a library reading room. Many people can read books at once, but when someone needs to reorganise the shelves (write), everyone has to leave first.

**Common pitfall**: Using `Lock` (write lock) where `RLock` (read lock) is sufficient — this serialises reads unnecessarily and degrades throughput. Also: forgetting `defer mu.Unlock()`, which causes a deadlock if the function returns early.

**In this project**: `Hub.Mu` guards the rooms map. Message forwarding (`handleForward`) only reads the map → `RLock`. Joining and leaving (`handleJoin`, `RemoveClient`) modify the map → `Lock`.

---

### Error Wrapping (`fmt.Errorf` with `%w`)

**What it is**: Go 1.13 introduced error wrapping: `fmt.Errorf("context: %w", err)` creates a new error that *contains* the original. `errors.Is(err, target)` and `errors.As(err, &target)` can unwrap the chain to find the root cause.

**Mental model**: Like nested envelopes. Each layer adds context ("failed to join room: failed to generate token: crypto/rand: ...") without destroying the original typed error inside.

**Common pitfall**: Using `fmt.Errorf("context: %v", err)` — `%v` formats the error as a string but does *not* wrap it. `errors.Is` can't unwrap it. This is the most common wrapping mistake in Go codebases.

**In this project**: All errors in `server/` must use `%w` for wrapping. This ensures that test code using `errors.Is` can identify root causes even through multiple layers of context.

---

### `gorilla/websocket`: ReadPump / WritePump Pattern

**What it is**: `gorilla/websocket` connections are **not safe for concurrent writes**. You must ensure only one goroutine writes at a time. The canonical solution is two goroutines per connection: one that only reads (`ReadPump`) and one that only writes (`WritePump`).

**Mental model**: The WebSocket connection is a single-lane road. `ReadPump` drives one direction, `WritePump` drives the other. They never share the road (the connection) at the same time for their respective operations.

**Common pitfall**: Calling `conn.WriteMessage` from multiple goroutines simultaneously → runtime panic with "concurrent write to websocket connection". Also: not setting `SetPongHandler` + `SetReadDeadline` in `ReadPump`, which means dead connections are never cleaned up ("ghost clients").

**In this project**: Every `Client` runs exactly this pattern. `WritePump` owns the `ticker` for heartbeat pings. `ReadPump` owns the pong deadline reset.

---

## 2. Rust / Tauri

### Ownership & Borrowing (Mental Model)

**What it is**: Rust's compiler enforces that every value has one owner; ownership can be transferred (moved) or temporarily lent (borrowed). A borrow is either shared (`&T`, many readers) or exclusive (`&mut T`, one writer). This is checked at compile time — no runtime garbage collector needed.

**Mental model**: Think of a library book. Only one person can *own* it (move). Many people can read it simultaneously (shared borrow `&T`). But only one person can annotate it, and nobody else can touch it while they do (mutable borrow `&mut T`).

**Common pitfall**: Fighting the borrow checker by cloning everything — this compiles but is often unnecessary. When you want to share data across threads, reach for `Arc<T>` (atomic reference counted) and for interior mutability, `Arc<Mutex<T>>`.

**In this project**: Rust is used for key derivation (`x25519-dalek`) and OS-level APIs (anti-capture). The Tauri command bridge (`#[tauri::command]`) takes ownership of arguments from JS, so understanding moves is important.

---

### `#[tauri::command]` and the JS Bridge

**What it is**: A Rust function annotated with `#[tauri::command]` is exposed to the JavaScript frontend via `invoke("command_name", args)`. Tauri serialises arguments from JSON → Rust types using `serde`, and the return value `Result<T, String>` back to JSON.

**Mental model**: It's a remote procedure call (RPC) across the process boundary — JS is the client, Rust is the server. The overhead of JSON serialisation means you design for *coarse-grained* calls (e.g., "derive a key once"), not per-frame operations.

**Common pitfall**: Returning complex nested errors from a Tauri command. The `Result<T, String>` signature expects the error to become a JavaScript string. Use `.map_err(|e| e.to_string())` to convert. Never `unwrap()` — a panic in a command handler will crash the webview process.

**In this project**: Used in Phase 4 (anti-capture APIs) and Phase 5 (key derivation). Key insight: the symmetric key for AES-GCM is derived in Rust and exported to JS *once* — per-frame IPC would be too slow for 30/60fps video.

---

### `unsafe` and `// SAFETY:` Comments

**What it is**: Rust's `unsafe` block is the escape hatch from the ownership rules. It allows raw pointer dereferencing, calling `extern "C"` FFI functions, and accessing mutable statics. The compiler cannot verify safety inside — *you* must.

**Mental model**: `unsafe` doesn't mean "dangerous code here" — it means "I am making a promise the compiler can't verify". The `// SAFETY:` comment is how you document that promise. If you can't write the comment, you don't understand the invariant yet.

**Common pitfall**: Writing `unsafe { ... }` without a `SAFETY:` comment is a red flag in code review. Also: marking a whole function `unsafe fn` when only one call inside it is unsafe — prefer a small `unsafe { }` block around only the unsafe operation.

**In this project**: Required for `SetWindowDisplayAffinity` (Windows) and `NSWindow.sharingType` (macOS) via FFI. Every `unsafe` block must have its `SAFETY:` comment justified.

---

## 3. TypeScript / React

### `useEffect` and Cleanup

**What it is**: `useEffect(fn, deps)` runs `fn` after render. If `fn` returns a function, React calls that cleanup function when the component unmounts or before the effect re-runs.

**Mental model**: Think of `useEffect` as "subscribe on mount, unsubscribe on unmount". The cleanup function is the unsubscription. Missing it causes memory leaks (event listeners, WebSocket handlers, intervals stay alive after the component is gone).

**Common pitfall**: Forgetting to return the cleanup function for subscriptions. Also: putting async functions directly in `useEffect` — you can't make the effect itself `async`; instead, define an async function *inside* the effect and call it, or use `.then()`.

**In this project**: `App.tsx` uses `useEffect` to connect to the signaling server and register a message listener. The cleanup unsubscribes the listener and calls `signalingService.disconnect()`.

---

### Service Singletons vs. React Context

**What it is**: A singleton is a single shared instance of a class/object, exported from a module. React Context is a built-in mechanism for sharing values through the component tree without prop-drilling.

**Mental model**: A singleton is like a global, but module-scoped. Safe in a browser app (one page, one instance). Context is the React-idiomatic way to share state that changes over time and needs to trigger re-renders.

**When to use each**: Use a singleton for services that have their own lifecycle and don't need to trigger React re-renders (e.g., `SignalingService`, a logger). Use Context for shared state that components read and react to (e.g., "current user", "call status").

**In this project**: `signalingService` is a module singleton — it manages the WebSocket lifecycle independently. Components subscribe via `onMessage` and update their own state with `useState`.

---

### TypeScript Discriminated Unions

**What it is**: A union type where each variant has a literal type field that the compiler uses to narrow the type in `if`/`switch` blocks: `type Msg = { type: "join"; token: string } | { type: "offer"; sdp: string }`.

**Mental model**: Like a tagged envelope — the `type` tag tells you which shape the rest of the data has. The compiler enforces exhaustiveness in `switch` statements.

**Common pitfall**: Using `string` for the discriminant instead of a string literal type, which defeats narrowing. Also: using `any` for the payload instead of `unknown` — `unknown` forces you to narrow before using it.

**In this project**: `MessageType` and `Envelope` in `src/types/signaling.ts` use this pattern. The `payload` field is typed `unknown` precisely so callers must narrow it before reading properties.

---

## 4. WebRTC

### The Signaling vs. Media Plane Split

**What it is**: WebRTC separates *signaling* (how peers find and describe themselves) from *media* (actual audio/video data). The WebRTC spec deliberately does not define how signaling works — you implement it (WebSockets, HTTP, carrier pigeon).

**Mental model**: Signaling is the phone directory. Media is the phone call itself. You use the directory to find the number and agree on a connection, then the call goes peer-to-peer. The directory never sees your conversation.

**In this project**: The Go signaling server handles the directory (SDP, ICE, pubkeys). The media plane (`RTCPeerConnection`) goes directly peer-to-peer via UDP, never touching the server.

---

### The Offer/Answer Model (SDP)

**What it is**: SDP (Session Description Protocol) is a text format describing a peer's media capabilities (codecs, IP addresses, ports). The *caller* creates an **offer** (`createOffer`), sets it as their local description, sends it via signaling. The *callee* receives it, sets it as their remote description, creates an **answer**, sends it back.

**Mental model**: Like a meeting request. Alice says "I can do video/audio, here are my available timeslots (ICE candidates), here's my codec list". Bob replies "Accepted, here are my timeslots and codec preferences". Both parties now know the plan.

**Critical ordering**: `setLocalDescription` → `send via signaling` → (other side) `setRemoteDescription` → `createAnswer` → `setLocalDescription` → `send via signaling` → `setRemoteDescription`. Getting this order wrong hangs the ICE state machine.

**Common pitfall**: Creating an offer *before* calling `addTrack` — the offer won't contain media sections. Always add tracks first.

**In this project**: Phase 3. The signaling server just forwards `offer` and `answer` type envelopes between the two peers in a room.

---

### ICE, STUN, and TURN

**What it is**:
- **ICE (Interactive Connectivity Establishment)**: The process of discovering and testing possible network paths between two peers.
- **STUN**: Tells a peer its public IP/port (what the internet sees). Free, low-bandwidth.
- **TURN**: A relay server. If P2P fails (symmetric NAT, corporate firewall), media flows through the TURN server. Essential for production — ~10–15% of connections fail without it.

**Mental model**: STUN is "hold up a mirror to see your own face" (your public address). TURN is "use a telephone operator to relay your call when you can't connect directly".

**Common pitfall**: Skipping TURN in production. Users behind symmetric NATs (common in corporate environments) silently fail to connect. Always plan TURN alongside STUN.

**ICE candidates**: As ICE gathers candidates (host, server-reflexive/STUN, relay/TURN), they are sent to the remote peer via signaling. *Trickle ICE* sends them as they're discovered rather than waiting for all of them — this speeds up connection time.

**In this project**: Phase 3 uses Google's public STUN for development. Production TURN via `coturn` is planned in Phase 3 Step 5.

---

### `RTCPeerConnection` State Machine

**What it is**: `RTCPeerConnection` has several state properties that transition as the connection is established:
- `signalingState`: tracks offer/answer exchange (`"stable"`, `"have-local-offer"`, `"have-remote-offer"`, etc.)
- `iceConnectionState`: tracks ICE (`"new"`, `"checking"`, `"connected"`, `"completed"`, `"failed"`, `"disconnected"`)
- `connectionState`: overall (`"new"`, `"connecting"`, `"connected"`, `"disconnected"`, `"failed"`)

**Common pitfall**: Ignoring `iceConnectionState === "failed"` and not attempting an ICE restart. Also: not tearing down the `RTCPeerConnection` on `connectionState === "failed"` — a failed connection must be replaced, not reused.

**In this project**: Phase 3 UI displays the connection state. Phase 3 hang-up tears down the `RTCPeerConnection` and sends a `leave` signaling message.

---

### `RTCRtpScriptTransform` (Encoded Transforms)

**What it is**: An API that lets you intercept encoded (but not yet encrypted by SRTP) RTP frames inside a `Worker`, process them (e.g., apply custom AES-GCM encryption), and re-enqueue them. This is how E2E encryption is applied per-frame without going through the main thread.

**Mental model**: A pipeline filter. Raw encoded video frames flow through your Worker, get custom-encrypted, then exit to the network stack. On the receive side, they enter your Worker, get decrypted, then flow to the decoder.

**Common pitfall**: Using the legacy `createEncodedStreams` API — it's non-standard and only works in Chrome. Use `RTCRtpScriptTransform` (supported in Chrome and Safari 15.4+). Also: the `CryptoKey` must be passed to the Worker via `postMessage` — it cannot be created in the main thread and used in the Worker without transfer.

**In this project**: Phase 5. The AES-256-GCM key is derived in Rust, exported to JS once, imported as a `CryptoKey` via `SubtleCrypto.importKey`, passed to the transform Worker, and used for per-frame encryption inside `RTCRtpScriptTransform`.

---

## 5. Security Concepts

### X25519 Diffie-Hellman Key Exchange

**What it is**: An elliptic-curve Diffie-Hellman protocol. Both parties generate a keypair (private + public). Each sends their public key to the other. Both independently compute the same shared secret from: `shared = DH(myPrivateKey, theirPublicKey)`. The shared secret never travels over the network.

**Mental model**: Alice and Bob each pick a random private number. They derive a public value and exchange it. Using a mathematical property of the elliptic curve, they both derive the same shared value — but an eavesdropper seeing only the public values cannot compute it (discrete log problem).

**Common pitfall**: Confusing "public key" with "session key" — the X25519 output is not directly safe to use as an encryption key. It must be passed through a KDF (Key Derivation Function, like HKDF) first.

**In this project**: Phase 5. Keypairs generated in Rust (`x25519-dalek`). Public keys exchanged via signaling (`pubkey` message type). Shared secret derived → HKDF → AES-256-GCM key.

---

### HKDF (HMAC-based Key Derivation Function)

**What it is**: A two-step KDF (RFC 5869): *extract* a pseudorandom key from the input key material, then *expand* it to the desired output length. Turns a high-entropy but non-uniform secret (like a DH output) into a uniform, usable key.

**Common pitfall**: Using the raw DH output as the encryption key — it's biased and may have structure an attacker could exploit. Always run it through HKDF.

**In this project**: Rust's `hkdf` crate, SHA-256 as the hash. Input: X25519 shared secret. Output: 32-byte AES-256-GCM key.

---

### AES-GCM and IV Reuse

**What it is**: AES-GCM (Galois/Counter Mode) is an authenticated encryption scheme. It provides both confidentiality AND integrity (a 16-byte authentication tag detects tampering). Requires a 12-byte IV (Initialization Vector / nonce) that must be unique per encryption.

**The fatal pitfall**: **IV reuse with the same key is catastrophic** — it completely breaks both confidentiality and integrity. An attacker who sees two ciphertexts with the same (key, IV) pair can XOR them to eliminate the keystream and attack the plaintexts.

**Solution**: Generate a cryptographically random 12-byte IV for every single frame: `crypto.getRandomValues(new Uint8Array(12))`. Prepend the IV to the ciphertext so the receiver can extract it.

**In this project**: Phase 5. Every `encryptFrame` call generates a fresh random IV. The IV is prepended to the encrypted frame data.

---

### SAS Fingerprint Verification

**What it is**: Short Authentication String — a human-readable code derived from the shared secret (or a hash of the public keys). Both peers compute it and verify it matches by reading it aloud or comparing it out-of-band.

**Why it matters**: Even with X25519 key exchange, a MITM (e.g., the signaling server) could substitute public keys, establishing separate shared secrets with each peer while relaying traffic. SAS defeats this — if the MITM substituted keys, the SAS on each side will differ.

**Common pitfall**: Displaying the SAS but not prompting the user to actively verify it, turning it into a UI nicety instead of a security control.

**In this project**: Phase 5. First 6 bytes of the shared secret → encoded as a 4-word mnemonic or 6-digit code. Displayed prominently. Call is marked "Verified" only after explicit user confirmation.

---

### Timing Attacks and Constant-Time Comparison

**What it is**: A timing attack exploits the fact that `==` string comparison short-circuits — it returns `false` as soon as a character differs. An attacker can measure response time to infer how many characters of a secret matched.

**Solution**: `crypto/subtle.ConstantTimeCompare(a, b)` in Go. Runs in time proportional to the length of the inputs, regardless of where the first mismatch occurs.

**In this project**: Used in `handleJoin` for invite token validation. Never use `env.Token == room.Token` for secret comparison.

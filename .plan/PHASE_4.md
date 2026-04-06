# Phase 4: Anti-Screen-Capture (Detailed Plan)

**Goal:** The video chat window is invisible to screen capture tools (OBS, PrintScreen, screenshot, Discord screen share) on Windows and macOS. Linux shows a warning banner. Protection toggles on during active calls and off in the lobby.

> [!IMPORTANT]
> This plan is a detailed breakdown of Phase 4 from [PLAN.md](file:///Users/semen/_dev/_pet/priv_chat/.plan/PLAN.md#L177-L314). It does **not** propose code changes — it's a granular implementation guide for you (the developer) to follow.

> [!CAUTION]
> This is the project's unique selling point. Every step includes verification criteria specific to the target platform. Do not advance to the next step until your current platform passes verification.

---

## Learning Objectives for This Phase

By completing Phase 4, you will understand:

- **Tauri v2's `setContentProtected` API** — what it wraps on each OS, when it's sufficient, and when you need to go lower
- **Platform FFI in Rust** — calling Win32 and AppKit APIs from Rust via `unsafe`, and why every `unsafe` block demands a `// SAFETY:` comment
- **Conditional compilation** — how `#[cfg(target_os = "...")]` eliminates platform-specific code from the binary at compile time (not at runtime)
- **Tauri's capability permission model** — why JS API calls fail without the corresponding permission in `capabilities/default.json`
- **Graceful degradation design** — how to communicate protection status to the user without false assurance

---

## Concept Primer: How OS-Level Capture Protection Works

Before writing any code, read this to understand what the OS APIs actually do and why they differ.

> [!NOTE]
> **📚 The Window Capture Pipeline (What We're Breaking)**
>
> When a user takes a screenshot or starts a screen recording, the OS compositor assembles a bitmap of all visible windows. Screen capture tools (OBS, Snipping Tool, `screencapture`, etc.) request this composite from the OS.
>
> The OS provides hooks to **exclude** specific windows from this composite:
>
> | OS | API | Effect |
> |---|---|---|
> | **Windows** | `SetWindowDisplayAffinity(WDA_MONITOR)` | Window appears **black** in captures but visible on screen |
> | **Windows** | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` | Window is **completely absent** from captures (Win10 2004+) |
> | **macOS** | `NSWindow.sharingType = .none` | Window excluded from screenshots, screen recording, and AirPlay (macOS 12.0+) |
> | **Linux/X11** | *(none)* | X11 has no capture exclusion mechanism — any client can read any pixel |
> | **Linux/Wayland** | Compositor-dependent | Some compositors support `zwlr_screencopy_manager_v1` deny, but Tauri doesn't expose this |
>
> **Key insight**: These are *requests* to the OS compositor, not guarantees. A custom-compiled kernel or a hardware capture device bypasses all of them. The protection deters casual capture (screenshots, OBS, Discord screen share) — not a determined attacker with physical access.

> [!NOTE]
> **📚 `WDA_MONITOR` vs. `WDA_EXCLUDEFROMCAPTURE`**
>
> These are two levels of Windows protection with different compatibility:
>
> - **`WDA_MONITOR`** (Windows 7+): The window shows as a **black rectangle** in captures. The user can see it on their monitor, but any capture tool gets solid black. This is what Tauri's built-in `setContentProtected` uses.
> - **`WDA_EXCLUDEFROMCAPTURE`** (Windows 10 version 2004+): The window is **completely invisible** — capture tools don't see it at all, as if it doesn't exist. This is stronger but requires a newer Windows version.
>
> For this project, the built-in `WDA_MONITOR` is the primary defense. The `WDA_EXCLUDEFROMCAPTURE` upgrade is an optional manual FFI exercise — useful for learning `unsafe` Rust and Win32 interop, and provides stronger protection for users on modern Windows.

> [!NOTE]
> **📚 Tauri v2's `setContentProtected` — The Built-In Path**
>
> Tauri v2 wraps the OS-native protection behind a single cross-platform API:
>
> - **JS**: `getCurrentWebviewWindow().setContentProtected(true)`
> - **Rust (build-time)**: `WebviewWindowBuilder::new(...).content_protected(true)`
> - **Config**: `contentProtected: true` in `tauri.conf.json` window config
>
> Internally, Tauri calls `SetWindowDisplayAffinity(WDA_MONITOR)` on Windows and `NSWindow.sharingType = .none` on macOS. On Linux, it's a no-op.
>
> **Why use the JS runtime call instead of build-time config?** Because we want to:
> 1. Toggle protection on/off (active during calls only, off in lobby)
> 2. Report the result to the UI (show shield icon state)
> 3. Attempt the stronger `WDA_EXCLUDEFROMCAPTURE` upgrade on Windows after the built-in call
>
> **Permission required**: The JS call fails silently without `core:window:allow-set-content-protected` in your capabilities file.

---

## Step 1 — Capability Permission & Basic Protection

### 1.1 Add the `setContentProtected` permission

Tauri v2's security model requires explicit permissions for every JS ↔ Rust bridge call. Without this, `setContentProtected` will fail silently.

Modify `src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "core:window:allow-set-content-protected"
  ]
}
```

> [!NOTE]
> **📚 Tauri v2 Capabilities Model**
>
> Tauri v2 replaced the blanket allowlist of v1 with a fine-grained capability system. Each window has a set of permissions that explicitly name every IPC bridge it can access. This is defense-in-depth: even if an XSS vulnerability allows arbitrary JS execution, the attacker can only call APIs that the capability file permits.
>
> `core:window:allow-set-content-protected` grants the frontend permission to call the `setContentProtected` method on the window object. Without it, the method still exists in the TypeScript API (it's auto-generated), but the Rust backend will reject the call.
>
> **Pitfall**: Adding permissions to the *wrong* capabilities file. If your app has multiple windows with separate capability files, each window needs its own permission. For this project, we have a single `main` window — one file is enough.

### 1.1b Install the `@tauri-apps/plugin-os` plugin

The anti-capture service needs reliable platform and OS version detection. Tauri v2's OS plugin provides `platform()` and `version()` — use these instead of parsing `navigator.userAgent`, which is frozen/unreliable in Tauri's webviews (e.g. WebKitGTK may include "Mac" in its WebKit version string, and macOS WebKit freezes the reported OS version at `10_15_7` regardless of actual version).

```bash
# Frontend dependency
pnpm add @tauri-apps/plugin-os

# Rust dependency (run from src-tauri/)
cargo add tauri-plugin-os
```

Register the plugin in `src-tauri/src/lib.rs` (alongside the existing opener plugin):

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_os::init())
    // ...
```

> [!WARNING]
> **Do not use `navigator.userAgent` for platform detection in Tauri.** Tauri's webviews (WebKitGTK on Linux, WebKit on macOS, WebView2 on Windows) produce UA strings that don't follow browser conventions. The OS plugin is the canonical, reliable alternative.

### 1.2 Create the anti-capture service

Create `src/services/anti-capture.ts`. This module wraps the Tauri API call and provides a clean interface for the call component:

```ts
// src/services/anti-capture.ts
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { platform } from "@tauri-apps/plugin-os";

/** Protection status reported to the UI */
export type ProtectionStatus = "active" | "unavailable" | "off";

/**
 * Enables OS-level screen capture protection on the current window.
 * Returns the protection status after the attempt.
 *
 * - Windows/macOS: returns "active" (API call succeeded — see caveat below)
 * - Linux: returns "unavailable" (no OS support)
 * - Errors: returns "unavailable" (logs the error, does not throw)
 *
 * **Caveat**: "active" means the Tauri API call resolved without error.
 * It does NOT mean we independently verified the OS applied the protection.
 * On edge cases (very old Windows, unusual window types), the call may
 * succeed silently. The shield icon communicates best-effort status.
 */
export async function enableCaptureProtection(): Promise<ProtectionStatus> {
  try {
    const appWindow = getCurrentWebviewWindow();
    await appWindow.setContentProtected(true);

    // setContentProtected is a no-op on Linux — detect and report
    const os = await platform();
    if (os === "linux") {
      return "unavailable";
    }

    return "active";
  } catch (err) {
    console.error("[AntiCapture] Failed to enable protection:", err);
    return "unavailable";
  }
}

/**
 * Disables screen capture protection (allows normal screenshots of lobby).
 *
 * On Windows, this also resets any WDA_EXCLUDEFROMCAPTURE upgrade from Step 2,
 * because Tauri's setContentProtected(false) internally calls
 * SetWindowDisplayAffinity(WDA_NONE), which clears ALL display affinities.
 */
export async function disableCaptureProtection(): Promise<void> {
  try {
    const appWindow = getCurrentWebviewWindow();
    await appWindow.setContentProtected(false);
  } catch (err) {
    console.error("[AntiCapture] Failed to disable protection:", err);
  }
}
```

> [!TIP]
> **🔗 Phase 3 → Phase 4 Bridge: Service Singleton Pattern**
>
> In Phase 3, you created `WebRTCService` and `getLocalStream` as service modules that the call component imports and calls. `anti-capture.ts` follows the same pattern: a service module that encapsulates platform-specific complexity behind a simple `enableCaptureProtection()` / `disableCaptureProtection()` interface. The call component doesn't need to know about `setContentProtected`, `WDA_MONITOR`, or `NSWindow.sharingType` — it just gets a `ProtectionStatus` back.

### 1.3 Verify basic protection works

Before adding the Windows FFI upgrade or UI integration, verify the built-in API works:

1. Add a temporary test in `src/App.tsx` (inside the `useEffect` that runs on mount):
   ```ts
   import { enableCaptureProtection } from "./services/anti-capture";

   // Inside the mount useEffect, after signaling connect:
   enableCaptureProtection().then(status => {
     console.log("[AntiCapture] Protection status:", status);
   });
   ```
2. Run `pnpm tauri dev`
3. **macOS**: Take a screenshot with `Cmd+Shift+5` — the app window area should be black/blank
4. **Windows**: Open Snipping Tool (`Win+Shift+S`) — the app window should appear black
5. Check the console for `[AntiCapture] Protection status: active`

Remove the temporary test after verification — the real integration happens in Step 4.

---

## Step 2 — Windows: `WDA_EXCLUDEFROMCAPTURE` Upgrade (Optional FFI)

> [!NOTE]
> **📚 Concept: `unsafe` in Rust — The FFI Escape Hatch**
>
> Rust's ownership system guarantees memory safety at compile time. But when calling C or Win32 APIs via FFI (Foreign Function Interface), the Rust compiler can't verify the safety of the external code. The `unsafe` block is a deliberate, visible marker that says: "I, the developer, have manually verified that these invariants hold."
>
> Every `unsafe` block in production code should have a `// SAFETY:` comment explaining *why* it's safe — what invariants you checked, and what guarantees you're relying on. This isn't a style preference; it's a contract with future readers (and your future self).
>
> **Pitfall**: Saying `// SAFETY: trust me` or omitting the comment entirely. The comment must name the specific invariants: "the HWND is valid because it was obtained from Tauri", "the function is safe to call from any thread", etc.

### 2.1 Add platform-conditional dependencies

Modify `src-tauri/Cargo.toml` to add the `windows` crate **only** on Windows builds:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-os = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[target.'cfg(target_os = "windows")'.dependencies]
windows = { version = "0.58", features = ["Win32_UI_WindowsAndMessaging", "Win32_Foundation"] }
```

> [!NOTE]
> **📚 Concept: `[target.'cfg(...)'.dependencies]` — Conditional Compilation for Dependencies**
>
> This `Cargo.toml` syntax tells Cargo: "Only download, compile, and link this crate when building for the specified platform." The `windows` crate is ~200MB of Win32 API bindings — you don't want it in your macOS or Linux builds.
>
> The `cfg()` syntax mirrors the `#[cfg()]` attribute used in Rust source code. Both use the same target predicates: `target_os`, `target_arch`, `target_family`, etc.
>
> Feature flags (`Win32_UI_WindowsAndMessaging`, `Win32_Foundation`) further limit which parts of the `windows` crate are compiled. Without feature-gating, you'd compile bindings for *every* Win32 API — tens of thousands of functions you don't need.

### 2.2 Write the Tauri command

Add the `enable_anti_capture` command to `src-tauri/src/lib.rs`:

```rust
/// Attempts to upgrade Windows screen capture protection to WDA_EXCLUDEFROMCAPTURE.
/// This makes the window completely invisible (not just black) in captures.
/// Returns Ok(()) on success or on non-Windows platforms (no-op).
#[tauri::command]
fn enable_anti_capture(window: tauri::Window) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
        };

        let hwnd = window.hwnd().map_err(|e| e.to_string())?;

        // SAFETY: `hwnd` is a valid window handle obtained from Tauri's Window struct.
        // `SetWindowDisplayAffinity` is safe to call with any valid HWND and a defined
        // affinity constant. It does not take ownership of the handle.
        //
        // NOTE: The HWND constructor changed across windows-rs versions.
        // With windows 0.58, verify the exact constructor signature with `cargo check`.
        // It may be HWND(hwnd.0 as *mut _) or HWND(hwnd.0 as isize) depending on
        // the version. Pin-test this on a Windows machine before implementation.
        unsafe {
            SetWindowDisplayAffinity(
                HWND(hwnd.0 as *mut std::ffi::c_void),
                WDA_EXCLUDEFROMCAPTURE,
            )
            .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = &window; // Suppress unused variable warning on non-Windows
    Ok(())
}
```

> [!NOTE]
> **📚 Understanding `#[cfg(target_os = "windows")]`**
>
> This attribute performs **compile-time** platform branching. The code inside the `#[cfg(...)]` block literally does not exist in the macOS binary — it's not compiled, not linked, not present. This is different from a runtime `if` check (like `if cfg!(target_os = "windows")`) which compiles the code but skips it at runtime.
>
> For FFI code that references platform-specific types (`HWND`, `NSWindow`), compile-time exclusion is mandatory — the types don't exist on other platforms, so even compiling them would fail.
>
> **Pitfall**: Forgetting the unused-variable suppression after a `#[cfg]` block that uses `window`. The Rust compiler warns about unused variables on non-Windows platforms. Use `#[cfg(not(target_os = "windows"))] let _ = &window;` — the `&` borrow (rather than `let _ = window;`) avoids moving the value, which is a good habit even when the move is harmless here.

### 2.3 Register the command

Update the Tauri builder in `src-tauri/src/lib.rs` to include the new command:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, enable_anti_capture])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 2.4 Call from the frontend

Update `src/services/anti-capture.ts` to attempt the upgrade after the built-in call:

```ts
import { invoke } from "@tauri-apps/api/core";

/**
 * Attempts to upgrade Windows protection to WDA_EXCLUDEFROMCAPTURE.
 * Falls back silently to the built-in WDA_MONITOR if it fails.
 */
async function tryWindowsUpgrade(): Promise<void> {
  try {
    await invoke("enable_anti_capture");
  } catch (err) {
    // Expected to fail on non-Windows or older Windows versions.
    // The built-in WDA_MONITOR from Step 1 is still active.
    console.debug("[AntiCapture] WDA_EXCLUDEFROMCAPTURE upgrade skipped:", err);
  }
}
```

Then call it from `enableCaptureProtection()`:

```ts
export async function enableCaptureProtection(): Promise<ProtectionStatus> {
  try {
    const appWindow = getCurrentWebviewWindow();
    await appWindow.setContentProtected(true);

    const os = await platform();
    if (os === "linux") {
      return "unavailable";
    }

    // On Windows, attempt stronger protection (no-op failure is fine)
    if (os === "windows") {
      await tryWindowsUpgrade();
    }

    return "active";
  } catch (err) {
    console.error("[AntiCapture] Failed to enable protection:", err);
    return "unavailable";
  }
}
```

> [!WARNING]
> **The `invoke` call requires the `enable_anti_capture` command to be registered in `generate_handler!`.** If you forget to register it (Step 2.3), `invoke` will reject with a cryptic "command not found" error — not a compilation error. This is a runtime failure that only appears when the frontend actually calls `invoke`.

> [!NOTE]
> **📚 Why no separate `disable_anti_capture` FFI command?**
>
> You might expect a matching `disable_anti_capture` Rust command to reset `WDA_EXCLUDEFROMCAPTURE`. It's not needed: Tauri's `setContentProtected(false)` internally calls `SetWindowDisplayAffinity(hwnd, WDA_NONE)`, which clears **any** display affinity — including `WDA_EXCLUDEFROMCAPTURE`. The `disableCaptureProtection()` function in Step 1.2 already handles the full teardown path.

---

## Step 3 — macOS: Verify & Handle Older Versions

### 3.1 Verify `setContentProtected` on macOS

Tauri's `setContentProtected(true)` internally calls `NSWindow.sharingType = .none` on macOS. **No manual FFI is needed** — the built-in API handles it.

Verify:
1. Run `pnpm tauri dev` on macOS
2. Take a screenshot with `Cmd+Shift+5` — the app area should be black
3. Start a QuickTime screen recording — the app window should be excluded
4. Check the console for `[AntiCapture] Protection status: active`

### 3.2 Handle macOS < 12.0

`NSWindow.sharingType = .none` requires macOS 12.0 (Monterey). On older versions, `setContentProtected` silently succeeds but has no effect — the window remains capturable.

Use `@tauri-apps/plugin-os` (installed in Step 1.1b) to get the real OS version — do **not** parse `navigator.userAgent`, because macOS WebKit freezes the reported version at `10_15_7` regardless of actual macOS version.

```ts
import { version } from "@tauri-apps/plugin-os";

/**
 * Checks if the current macOS version supports capture protection (12.0+).
 * Uses the OS plugin for reliable version detection.
 */
async function isMacOSVersionSupported(): Promise<boolean> {
  const ver = await version();
  const major = Number.parseInt(ver.split(".")[0], 10);
  return major >= 12;
}
```

Use this in `enableCaptureProtection`:

```ts
const os = await platform();
if (os === "macos" && !(await isMacOSVersionSupported())) {
  return "unavailable";
}
```

> [!NOTE]
> **📚 Why Not Use Manual FFI for macOS?**
>
> The PLAN.md includes the `NSWindow` pointer extraction method (`window.ns_window()`) for reference, but Tauri's built-in `setContentProtected` already does exactly what we need. Manual FFI would only be justified if:
> 1. We needed `sharingType = .readOnly` (allows screenshots but blocks recording) — a different behavior than `.none`
> 2. We needed to set a custom `sharingType` based on call state (Tauri's API is binary: on or off)
>
> Neither applies to our use case. Avoid unnecessary FFI — it adds `unsafe` code, platform-specific crates, and maintenance burden for zero functional benefit.

---

## Step 4 — Linux: Warning-Only for MVP

### 4.1 Detection and warning

On Linux, `setContentProtected` is a no-op in Tauri v2. The `enableCaptureProtection` function already returns `"unavailable"` for Linux (Step 1.2). The UI integration in Step 5 displays a warning banner based on this status.

There is nothing to implement in this step beyond what Step 1.2 already handles for the `"linux"` platform path.

> [!NOTE]
> **📚 Why Linux Can't Do Capture Protection**
>
> **X11** (the legacy display server): Any X11 client can call `XGetImage` on any window — there is no permission model in the X11 protocol. The compositor has no mechanism to exclude a window from screen captures because all clients share a flat address space of pixel buffers. This is a fundamental architectural limitation, not a missing feature.
>
> **Wayland** (the modern replacement): Wayland's security model is the opposite — clients can only see their own surfaces. Screen capture requires an explicit portal/protocol (`xdg-desktop-portal`, `zwlr_screencopy_manager_v1`), and the compositor controls access. This is why the Linux desktop is migrating from X11 to Wayland.
>
> However, Wayland capture exclusion is compositor-specific and Tauri doesn't expose it, so even on Wayland we can't offer protection today.

### 4.2 Wayland compositor exclusion — deferred

Some Wayland compositors (Sway, KDE 6+) support `zwlr_screencopy_manager_v1` which can deny screen capture for specific surfaces. However:
- Tauri doesn't expose this API
- It requires compositor-specific C FFI from Rust
- It only works on a subset of Linux compositors

This is deferred to a future enhancement or Phase 7. For now, the warning banner is the correct MVP approach.

### 4.3 Visual watermarking — deferred to Phase 7

PLAN.md Phase 7, Step 2 covers a semi-transparent per-user watermark (username + timestamp) overlaid on the video canvas as a Linux fallback deterrent. This is a UI feature, not an OS API integration, and belongs with the polish phase.

---

## Step 5 — Frontend Integration & Degradation UX

### 5.1 Wire anti-capture to the call lifecycle

The protection should be **active only during calls** — not while the user is in the lobby. This allows normal screenshots of the lobby (useful for sharing room IDs) while protecting the actual video content.

In the call component, toggle protection when entering/leaving a call:

```tsx
import { useState, useEffect } from "react";
import {
  enableCaptureProtection,
  disableCaptureProtection,
  type ProtectionStatus,
} from "./services/anti-capture";

// In the call component:
const [protectionStatus, setProtectionStatus] = useState<ProtectionStatus>("off");

// Enable protection when entering a call
// (inRoom is already tracked by Phase 3's call component)
useEffect(() => {
  if (inRoom) {
    enableCaptureProtection().then(setProtectionStatus);
    // Cleanup: disable protection if component unmounts while in a call
    // (e.g., window close, React strict mode double-mount)
    return () => {
      disableCaptureProtection();
      setProtectionStatus("off");
    };
  }
}, [inRoom]);
```

> [!TIP]
> **🔗 Phase 3 → Phase 4 Bridge: Same `inRoom` State, New Side Effect**
>
> Phase 3's call component already tracks `inRoom` state — it's set to `true` when the user joins a room, and `false` when they leave or hang up. Phase 4 hooks into this same state variable via a new `useEffect`. You're not adding new state management — you're adding a new side effect to an existing state transition.
>
> This is the same pattern as Phase 3's `useEffect` that acquires the local media stream when `inRoom` changes. The anti-capture toggle is just another resource lifecycle tied to the call.

### 5.2 Render the shield icon and warning banner

Add a protection status indicator to the call UI. This should be visible whenever the user is in a room:

```tsx
// Shield icon component (inline for simplicity — extract to a component if desired)
function ProtectionIndicator({ status }: { status: ProtectionStatus }) {
  if (status === "off") return null;

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "8px 12px",
      borderRadius: "6px",
      fontSize: "14px",
      background: status === "active"
        ? "rgba(34, 197, 94, 0.1)"
        : "rgba(234, 179, 8, 0.1)",
      color: status === "active" ? "#16a34a" : "#ca8a04",
      border: `1px solid ${status === "active" ? "#16a34a33" : "#ca8a0433"}`,
    }}>
      <span style={{ fontSize: "18px" }}>
        {status === "active" ? "🛡️" : "⚠️"}
      </span>
      <span>
        {status === "active"
          ? "Screen capture protection active"
          : "Screen capture protection unavailable on this platform"}
      </span>
    </div>
  );
}
```

Place it in the call view (the `inRoom` branch of the JSX):

```tsx
{inRoom && (
  <div>
    <ProtectionIndicator status={protectionStatus} />
    {/* ... existing video elements, call controls, etc. */}
  </div>
)}
```

> [!IMPORTANT]
> **Design decisions for the shield icon:**
> - **Always visible during a call** — do not hide it. The user should always know their protection status.
> - **Green = active**: Windows (`WDA_MONITOR` or `WDA_EXCLUDEFROMCAPTURE`) or macOS (`sharingType = .none`) is applied.
> - **Yellow = unavailable**: Linux, macOS < 12.0, or any failure case. Shows a text explanation.
> - **Hidden when not in a call**: `"off"` status renders nothing — the lobby doesn't need a shield icon.
> - **No "error" state**: If `setContentProtected` fails, we degrade to `"unavailable"` — not a crash. The user can still make calls; they just don't have capture protection.

### 5.3 Complete integration example

Here is the complete `useEffect` addition and JSX change to `src/App.tsx`, showing only the Phase 4 additions relative to the existing Phase 3 call component:

```tsx
// === New imports (add to existing imports at top of App.tsx) ===
import {
  enableCaptureProtection,
  disableCaptureProtection,
  type ProtectionStatus,
} from "./services/anti-capture";

// === New state (add alongside existing state declarations) ===
const [protectionStatus, setProtectionStatus] = useState<ProtectionStatus>("off");

// === New useEffect (add alongside existing useEffects) ===
useEffect(() => {
  if (inRoom) {
    enableCaptureProtection().then(setProtectionStatus);
    return () => {
      disableCaptureProtection();
      setProtectionStatus("off");
    };
  }
}, [inRoom]);

// === JSX: Add ProtectionIndicator inside the inRoom view ===
// Place it after the room title and before the video elements:
<ProtectionIndicator status={protectionStatus} />
```

> [!WARNING]
> **Don't call `enableCaptureProtection` on `DOMContentLoaded` or component mount.** If protection is always-on, the user can't screenshot the lobby to share a room ID or invite token. Toggle it with the call lifecycle (`inRoom` state).

---

## Step 6 — Optional: Detect Recording Software

This step is a **soft deterrent** — it detects known screen recording processes and shows a warning. It is easily bypassed (rename the executable) and should never be relied upon for security.

### 6.1 Tauri command to scan processes

Add the `sysinfo` crate to `src-tauri/Cargo.toml` (the previous shell-out approach via `tasklist`/`ps` had issues: locale-dependent output on Windows, process name truncation on macOS, and unqualified PATH resolution):

```toml
[dependencies]
# ... existing dependencies ...
sysinfo = { version = "0.33", default-features = false, features = ["system"] }
```

Add to `src-tauri/src/lib.rs`:

```rust
use sysinfo::System;

/// Scans running processes for known screen recording software.
/// Returns a list of detected recorder names (empty if none found).
///
/// NOTE: This is a soft deterrent only — trivially bypassed by renaming
/// the executable. Do not rely on this for security.
#[tauri::command]
fn detect_recorders() -> Vec<String> {
    let known_recorders = [
        "obs", "obs64", "obs32",
        "bandicam", "bdcam",
        "camtasia", "snagit",
        "xsplit", "streamlabs",
        "screencastify",
    ];

    let sys = System::new_with_specifics(
        sysinfo::RefreshKind::nothing().with_processes(sysinfo::ProcessRefreshKind::nothing()),
    );

    let mut detected = Vec::new();
    for process in sys.processes().values() {
        let name = process.name().to_string_lossy().to_lowercase();
        for recorder in &known_recorders {
            if name.contains(recorder) && !detected.contains(&recorder.to_string()) {
                detected.push(recorder.to_string());
            }
        }
    }

    detected
}
```

Register it:

```rust
.invoke_handler(tauri::generate_handler![greet, enable_anti_capture, detect_recorders])
```

> [!NOTE]
> **📚 Why `sysinfo` instead of `tasklist`/`ps`?**
>
> The previous approach shelled out to OS commands (`tasklist` on Windows, `ps -eo comm` on macOS/Linux). This had several problems:
> - **Windows**: `tasklist` output format varies by locale (German Windows outputs headers in German)
> - **macOS**: `ps -eo comm` truncates process names to 16 characters (`MAXCOMLEN`)
> - **Security**: Unqualified PATH resolution means a malicious directory in `PATH` could intercept the command
>
> The `sysinfo` crate is pure Rust, cross-platform, and reads process information directly from OS APIs without spawning subprocesses.

### 6.2 Frontend warning

```ts
// In anti-capture.ts
import { invoke } from "@tauri-apps/api/core";

/**
 * Check for running screen recording software.
 * This is a soft deterrent only — easily bypassed.
 */
export async function checkForRecorders(): Promise<string[]> {
  try {
    return await invoke<string[]>("detect_recorders");
  } catch {
    return [];
  }
}
```

Call it when entering a room and show a non-blocking warning if recorders are found:

```tsx
useEffect(() => {
  if (inRoom) {
    checkForRecorders().then(recorders => {
      if (recorders.length > 0) {
        console.warn("[AntiCapture] Detected recorders:", recorders);
        // Show a dismissable warning toast (implementation left to the developer)
      }
    });
  }
}, [inRoom]);
```

> [!CAUTION]
> **Do not block the call based on recorder detection.** This check is trivially bypassed (rename the executable, use a lesser-known tool, or use OS-level screen capture). It's a courtesy warning, not a security control. Blocking the call would frustrate legitimate users without stopping determined actors.

---

## File Summary

| File | Action | Purpose |
|------|--------|---------|
| `src-tauri/capabilities/default.json` | **MODIFY** | Add `core:window:allow-set-content-protected` permission |
| `src-tauri/Cargo.toml` | **MODIFY** | Add `tauri-plugin-os`, `[target.'cfg(target_os = "windows")'.dependencies]` for `windows` crate, optionally `sysinfo` |
| `src-tauri/src/lib.rs` | **MODIFY** | Register `tauri_plugin_os`, add `enable_anti_capture` and optionally `detect_recorders` commands |
| `src/services/anti-capture.ts` | **NEW** | `enableCaptureProtection()`, `disableCaptureProtection()`, `tryWindowsUpgrade()`, `checkForRecorders()` |
| `src/App.tsx` | **MODIFY** | Add `protectionStatus` state, `useEffect` for call lifecycle toggle, `ProtectionIndicator` component |
| `package.json` | **MODIFY** | Add `@tauri-apps/plugin-os` dependency |

---

## Verification Plan

### Automated Tests

Phase 4 is primarily OS-level integration — limited automated test coverage. Focus on:

```bash
# TypeScript compilation (catches type errors in anti-capture service)
pnpm run lint

# Rust compilation on the development platform
cargo check --manifest-path src-tauri/Cargo.toml
```

### Manual Verification

> [!NOTE]
> All verification requires running the Tauri app: `pnpm tauri dev` (or `make dev-app`).

1. **macOS screenshot protection**:
   - Join a room (protection activates)
   - Take a screenshot with `Cmd+Shift+5` → the app area should be black/blank
   - Start a QuickTime screen recording → the app window should be excluded
   - Leave the room → take a screenshot → the lobby should be visible normally

2. **Windows screenshot protection** (if you have Windows access):
   - Join a room → `Win+Shift+S` Snipping Tool → app window is black
   - Open OBS → add "Window Capture" or "Display Capture" → app window is black (or absent if `WDA_EXCLUDEFROMCAPTURE` upgrade succeeded)

3. **Linux warning banner** (if you have Linux access):
   - Join a room → shield icon should show yellow ⚠️ with "unavailable" text
   - Screenshots work normally (expected — no protection on Linux)

4. **Shield icon states**:
   - In lobby: no shield icon visible
   - In room on Mac/Win: green 🛡️ shield with "active" text
   - In room on Linux: yellow ⚠️ shield with "unavailable" text

5. **Protection toggle on call end**:
   - Join a room → protection activates
   - Hang up or leave → protection deactivates
   - Take a screenshot → lobby is visible normally (not black)

6. **Console output**:
   - Check for `[AntiCapture] Protection status: active` (or `unavailable`) in the webview console

---

## Estimated Time: 3–4 days

### Common Blockers

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `setContentProtected` silently does nothing | Missing capability permission | Add `core:window:allow-set-content-protected` to `capabilities/default.json` |
| OBS still captures window (shows content, not black) | `setContentProtected` wasn't called, or called after window was already captured | Ensure the call happens *before* OBS starts capturing; restart OBS after enabling protection |
| `invoke("enable_anti_capture")` rejects with "command not found" | Command not registered in `generate_handler!` | Add `enable_anti_capture` to the handler list in `lib.rs` |
| `windows` crate compilation errors on macOS | Missing `[target.'cfg(target_os = "windows")']` conditional in `Cargo.toml` | Ensure the dependency is under the platform-conditional section, not `[dependencies]` |
| macOS screenshot still shows window content | macOS < 12.0 (Monterey) | Check version; show `"unavailable"` status |
| `window.hwnd()` method not found | Using wrong Tauri version or import | Ensure `tauri = "2"` and the parameter type is `tauri::Window` |
| Shield icon never appears | `protectionStatus` state not being set | Check that `enableCaptureProtection().then(setProtectionStatus)` is in the `inRoom` `useEffect` |
| Protection stays on after leaving room | `disableCaptureProtection` not called in cleanup | Ensure the `else` branch of the `inRoom` effect calls `disableCaptureProtection()` |

---

## Understanding Check

> [!IMPORTANT]
> Answer these **without looking** before advancing to Phase 5. They test synthesis, not recall.

1. **`WDA_MONITOR` vs. `WDA_EXCLUDEFROMCAPTURE`**: Both prevent OBS from capturing your window. What is the *user-visible* difference between them? Which one does Tauri's built-in `setContentProtected` use, and why might the stronger variant fail on some Windows machines?

2. **Capability permission model**: You deploy a version of the app without `core:window:allow-set-content-protected` in the capabilities file. The app compiles fine, `pnpm tauri dev` launches without errors, and the call connects successfully. Yet `setContentProtected` does nothing. Why isn't there a compilation error or a visible runtime error?

3. **Toggle vs. always-on**: Why do we call `setContentProtected(true)` when entering a call and `setContentProtected(false)` when leaving, instead of enabling protection once at app startup? Name two concrete UX scenarios where always-on protection would create problems.

4. **`unsafe` justification**: The `enable_anti_capture` command contains an `unsafe` block. Without looking at the code, explain: (a) why the *compiler* requires `unsafe` here, (b) what specific invariant the `// SAFETY:` comment asserts, and (c) what would happen if the HWND were invalid (e.g., the window was closed between obtaining the handle and calling `SetWindowDisplayAffinity`).

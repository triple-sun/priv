---
description: How to approach and implement ANY task or feature request in this project
---

# Feature Implementation Workflow

Follow this strict workflow when implementing any task, feature, or phase of the project:

## Phase 0: Teach First

Before planning or writing any code, identify the learning opportunity in this task.

1. **Identify the concept domain**: Which language/technology does this task primarily touch? (Go, Rust, TypeScript, WebRTC, Tauri?)
2. **Read `learning-guide.md`**: Find the relevant section and scan the key concepts.
3. **Surface the pattern**: In 1–3 sentences, name the pattern or concept being applied and *why* it fits. For example:
   - *"This uses Go's CSP model — goroutines communicate via channels rather than shared memory, which fits here because the WritePump and ReadPump goroutines need to coordinate without locks."*
   - *"This is the Subscriber pattern — the `SignalingService` exposes `onMessage(callback)` so multiple React components can listen to WebSocket events without coupling to each other."*
4. **Name one pitfall**: Identify one common mistake beginners make in this area (e.g., "reusing IVs with AES-GCM breaks confidentiality", "calling `SetRemoteDescription` before `SetLocalDescription` hangs the ICE machine").

This step should take 2–4 sentences. Skip it only for trivial edits (typo fixes, renaming).

---

## Phase 1: Planning and Comprehension

1. **Read Project Context**: Use `view_file` to review `.agents/project-context.md` and the `.plan/` directory to understand where the task fits in the architecture.
2. **Review Target Files**: Use `view_file` to read the exact codebase files that need modification.
3. **Draft a Verification Plan**: Ask yourself "How will I know this is complete?". Formulate specific verification commands (e.g., `make lint-app`, `cargo check`, writing a `_test.go` file). Explicitly state them in your thoughts.

## Phase 2: Surgical Implementation

1. **Make Minimal Changes**: Implement the feature focusing purely on the requirements.
2. **Comply with Rules**: Follow `.agents/coding-rules.md` strictly (no extra abstractions, cleanup only your orphans, add TSDoc, ensure Biome/tsconfig compliance passing).
3. **Comment the Why**: Where the code implements a non-obvious pattern (e.g., a non-blocking select, a RWMutex choice), add a brief inline comment explaining the reason, not just what the code does.
4. **Self-Correction Loop**: Do not notify the user yet. Test the code locally against your verification plan from Step 3.

## Phase 3: Verification

// turbo-all
7. Run formatters and linters (e.g., `make lint-app` or `make lint-server`).
8. Run any unit/integration tests added (e.g., `cd server && go test -race ./...`).
9. View any errors, and autonomously fix them. **Maximum 3 fix attempts.** If verification still fails after 3 attempts, stop and report the failure to the user with full diagnostics (error output, what you tried, and why it didn't work). Do not loop indefinitely.
10. Ensure the code aligns with the current project phase (check `project-context.md` → `current_phase`).

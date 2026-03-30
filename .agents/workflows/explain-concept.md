---
description: Explain a concept from the stack before coding — teach first, implement second
---

# Explain Concept Workflow

Use this workflow when you encounter an unfamiliar API, pattern, or language feature during development. The goal is to build a genuine mental model before writing code.

## When to Use

Trigger this workflow (or `/explain-concept`) when:
- You're about to use a language feature for the first time (e.g., `sync.RWMutex`, `RTCPeerConnection`, `RTCRtpScriptTransform`)
- You want to understand *why* a design decision was made (e.g., why ReadPump/WritePump instead of one goroutine)
- A bug appeared and the fix doesn't make intuitive sense yet
- You're preparing to move to the next phase and want to front-load the key concepts

## Steps

1. **Identify the concept domain**: Name the specific thing you want to understand. Be precise — "Go concurrency" is too broad; "why `sync.RWMutex` over `sync.Mutex`" is good.

2. **Read `learning-guide.md`**: Find the relevant section. Scan the key concepts, pitfalls, and links.

3. **Produce a structured explanation** in this order:
   - **What it is**: One sentence definition.
   - **Mental model**: An analogy or simplified model that makes the behaviour intuitive (e.g., "a channel is like a typed pipe between goroutines").
   - **How it works here**: Concretely, how this concept applies to the current codebase or task.
   - **Common pitfall**: The most frequent mistake beginners make with this concept.
   - **Verification**: How you can confirm your understanding (a tiny example, a test, a specific thing to observe).

4. **Optionally suggest an experiment**: A small, self-contained code snippet (20–40 lines) the developer can run in isolation — a Go playground link, a `main_test.go`, or a browser console snippet — to observe the concept in action without modifying the production codebase.

5. **Proceed to `/implement-task`** when ready. The explanation above becomes Phase 0 of the implementation workflow.

## Example Invocations

```
/explain-concept sync.RWMutex vs sync.Mutex in the Hub
/explain-concept WebRTC offer/answer model and SDP
/explain-concept why RTCRtpScriptTransform needs a Worker
/explain-concept X25519 Diffie-Hellman key exchange
/explain-concept Go error wrapping with %w and errors.Is
```

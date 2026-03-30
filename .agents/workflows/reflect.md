---
description: Structured reflection after completing a step or phase — consolidate what you learned before moving on
---

# Reflect Workflow

Use this workflow immediately after completing a step or phase. It takes 5–10 minutes and dramatically improves long-term retention via **active recall** — retrieving knowledge from memory rather than re-reading it.

## When to Trigger

```
/reflect          → after completing any step
/reflect phase    → after completing a full phase (longer form)
```

## What the Agent Will Do

When you invoke `/reflect`, the agent will:

1. **Ask what you just built** — identify the step/phase completed and the primary language/technology touched
2. **Read the relevant section of `learning-guide.md`** for the concepts exercised
3. **Ask you 2–3 targeted retrieval questions** tailored to what you just implemented (not generic — specific to the code you wrote)
4. **Wait for your answers**, then provide feedback: confirm what's correct, gently correct misconceptions, and fill in gaps
5. **Offer a LEARNINGS.md entry** — a 2–4 line summary of the most important insight from this session for you to paste into `LEARNINGS.md` at the project root

## Question Types

Reflection questions follow this structure, in order of cognitive difficulty:

| Type | Example |
|------|---------|
| **Recall** | "What does `RLock` allow that `Lock` doesn't?" |
| **Application** | "If you had 1000 concurrent clients, which line in your hub would be the bottleneck first?" |
| **Prediction** | "What happens if you remove `intentionallyDisconnected` and the server crashes?" |
| **Transfer** | "You're designing a Python async server with a similar routing requirement. What's the equivalent of the `Send chan []byte` channel?" |

The agent will start with an Application question (not Recall — that's too easy) and escalate to Prediction or Transfer if your answers are solid.

## Example Session

```
You: /reflect
Agent: What did you just finish implementing?

You: The WritePump/ReadPump goroutines and RemoveClient in hub.go

Agent: Good. Without running the code: you call hub.RemoveClient(c) 
       inside ReadPump's defer, then close c.Send. At that exact moment, 
       WritePump is blocked on `case message := <-c.Send`. 
       What happens to WritePump? Is this safe?

You: [your answer]

Agent: [confirms / corrects / extends]
       Here's a LEARNINGS.md entry for this session:
       ---
       ## 2026-03-30 — Go: Channel Close Semantics
       Closing a channel causes all goroutines blocked on receive to 
       unblock immediately with the zero value and ok=false. This is 
       how RemoveClient safely terminates WritePump without a separate 
       signal channel.
       ---
```

## LEARNINGS.md Format

If you don't have a `LEARNINGS.md` yet, create one at the project root:

```markdown
# Learnings

A living log of insights, corrections, and "aha" moments from building this project.
Format: ## <date> — <language/concept>: <one-line title>

---
```

Each entry should capture: **what you thought** vs. **what's actually true**, or **the precise insight** that made something click. Entries written in your own words are far more valuable than copied explanations.

# Project-Specific Coding Rules

> [!NOTE]
> You are also bound by the global `user_rules` (KISS, YAGNI, Surgical Changes, Goal-Driven Execution). This file adds **project-specific** constraints only. Do not duplicate the global rules.

## TypeScript / React (`src/`)

- Comply strictly with **Biome** formatting and linting (`pnpm run lint`).
- Comply with `tsconfig.json` strict mode — no `any`, no implicit returns.
- Annotate all exported types and functions with **TSDoc** comments.
- All React components must be functional components with explicit prop types.

## Rust / Tauri (`src-tauri/`)

- Lint with `cargo clippy -- -D warnings` — treat all warnings as errors.
- `#[deny(unsafe_code)]` at crate root unless OS-level FFI requires `unsafe` (anti-capture APIs). Justify every `unsafe` block with a `// SAFETY:` comment.
- Error handling: use `thiserror` for library errors, `anyhow` for application-level errors in commands.
- All Tauri commands must return `Result<T, String>` and handle errors gracefully — never `unwrap()` in command handlers.

## Go (`server/`)

- Lint with `golangci-lint run ./...` (not just `go vet`).
- Test with `go test -race ./...` to catch data races.
- Error wrapping: use `fmt.Errorf("context: %w", err)` for all wrapped errors.
- Package naming: short, lowercase, no underscores. Follow stdlib conventions.
- All exported functions and types must have doc comments.

## Cross-Cutting

- Verify targets: `make lint-app`, `make lint-server`.
- Never log sensitive data (private keys, tokens, SAS codes) at any log level.
- Match the existing style of the file you're editing, even if you'd do it differently.

---

## Why These Rules?

These constraints are deliberate teaching moments. Understanding the *reason* behind a rule helps you internalise it for use beyond this project.

### TypeScript
- **No `any`** → forces you to design precise discriminated union types (e.g., `type MessageType = "join" | "offer" | ...`). When you reach for `any`, it's a signal you haven't yet modelled the data correctly.
- **TSDoc on exports** → reinforces the habit of treating exported interfaces as a public API contract, not just "functions that happen to work".
- **Biome over Prettier+ESLint** → a single tool that enforces both formatting and linting. Teaches you that tooling consolidation reduces config drift.

### Rust
- **`#[deny(unsafe_code)]` + `// SAFETY:` comment** → the compiler can't verify `unsafe` code, so *you* must. Writing the `SAFETY:` comment forces you to articulate your invariant assumption — this is the Rust ownership model's escape hatch, used consciously.
- **`thiserror` for libs, `anyhow` for apps** → teaches the distinction between library error types (stable, typed, composable) and application error handling (context-rich, human-readable). You'll see this pattern everywhere in the Rust ecosystem.
- **Never `unwrap()` in command handlers** → a Tauri command panic unwinds to the OS, not to the JS caller. `unwrap()` here is a silent crash, not a recoverable error.

### Go
- **`fmt.Errorf("context: %w", err)`** → the `%w` verb wraps the error, enabling `errors.Is()` and `errors.As()` to unwrap it later. Without `%w`, you lose the original error type and caller context. This is idiomatic Go error handling since Go 1.13.
- **`go test -race`** → Go's race detector instruments memory accesses at runtime to catch unsynchronised concurrent reads/writes. The signaling server uses goroutines heavily; a race condition here causes subtle state corruption, not a crash.
- **`golangci-lint` over `go vet`** → `go vet` only catches obvious errors. `golangci-lint` runs dozens of linters (including `staticcheck`, `errcheck`) that catch bugs `go vet` misses, like ignoring error returns.

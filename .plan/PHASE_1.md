# Phase 1 Detailed Implementation Plan: Project Scaffolding & Dev Environment

This document expands Phase 1 of `PLAN.md` into concrete, step-by-step actions with robust verification criteria.
Follow these steps strictly. Do not advance to step N+1 until step N is fully verified.

## Step 1: Initialize the Tauri v2 App

**Goal:** Set up the Rust desktop shell and React/TypeScript frontend.

1. **Scaffold the project:**
   - Run: `pnpm create tauri-app@latest . -- --template react-ts --manager pnpm`
   - *Assumption:* This is executed in the `priv_chat` directory. Make sure the directory is empty or the command allows running in the current directory.
   - Run: `pnpm install`
2. **Pin Toolchains:**
   - Create a `rust-toolchain.toml` at the project root:

     ```toml
     [toolchain]
     channel = "stable"
     components = ["rustfmt", "clippy"]
     ```

   - *Reason:* Ensures deterministic builds across different machines (or CI runners).
3. **Verify:**
   - Run `pnpm run tauri dev`.
   - *Check:* A native OS window appears displaying the default Tauri + React welcome screen.

## Step 2: Initialize the Signaling Server

**Goal:** Create a standalone Go backend capable of echoing WebSocket messages.

1. **Scaffold the Go module:**
   - Run: `mkdir server && cd server`
   - Run: `go mod init privchat-signal`
   - Run: `go get github.com/gorilla/websocket`
2. **Write the minimum viable server (`server/main.go`):**
   - Import `net/http`, `log`, and `github.com/gorilla/websocket`.
   - Create a `websocket.Upgrader` with `CheckOrigin` returning `true` (for local development).
   - Implement an HTTP handler for `/ws` that upgrades the connection.
   - Inside the handler, write an infinite `for` loop to read messages (`conn.ReadMessage`) and echo them back (`conn.WriteMessage`).
   - Start the server on port `:8080` via `http.ListenAndServe(":8080", nil)`.
3. **Verify:**
   - In terminal 1: `cd server && go run main.go`
   - In terminal 2: Connect using a tool like `wscat` (install via `pnpm install -g wscat`) by running `wscat -c ws://localhost:8080/ws`.
   - *Check:* Type "test" and press enter. You must receive "test" back immediately.

## Step 3: Monorepo Housekeeping

**Goal:** Unify dev commands, syntax formatting, and CI checks.

1. **Create `Makefile`:**
   - Inside the root directory, configure the following targets to easily interact with the monorepo:

     ```makefile
     .PHONY: dev-app dev-server lint-app lint-server

     dev-app:
      pnpm run tauri dev

     dev-server:
      cd server && go run main.go

     lint-app:
      pnpm run lint
      cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

     lint-server:
      cd server && go vet ./...
     ```

2. **Editor Config:**
   - Create an `.editorconfig` mapping formats to language standards (e.g., 2 spaces for JS/TS/JSON files, and tabs for Go).
3. **Git Configuration:**
   - Create `.gitignore` to exclude at least:
     - `node_modules/`
     - `dist/`
     - `src-tauri/target/`
     - `server/privchat-signal` (compiled binary)
     - `.DS_Store`
4. **Setup CI (GitHub Actions):**
   - Create `.github/workflows/ci.yml`.
   - Define a single workflow with jobs/steps to:
     - Install Rust toolchain and check `src-tauri`.
     - Setup Node, install dependencies, and build the React app.
     - Setup Go and run `go build` inside the `server/` directory.
5. **Verify:**
   - Run `make dev-app` and confirm Tauri launches.
   - Run `make dev-server` and ensure the server responds to a WS connection.
   - Run `make lint-app` and log any complaints.
   - Run `make lint-server` cleanly.

---

## Understanding Check

> [!IMPORTANT]
> Answer these **without looking** before advancing to Phase 2. If you can't, re-read the relevant section — not to memorise, but to build the correct mental model.

1. **`rust-toolchain.toml`**: What specific problem does pinning the Rust toolchain version solve? What would break on a colleague's machine or in CI without it?

2. **Go `internal` package**: Why does Go enforce that code outside the module cannot import from an `internal/` directory? What design goal does this serve when the signaling server grows larger?

3. **Separate binary**: The signaling server is a standalone Go binary, not part of the Tauri Rust backend. What are two concrete reasons this separation is the right architectural choice for this project?

---

**Ready for Phase 2?**
Ask yourself: *Can I type `make dev-app` to see my UI and `make dev-server` to start the websocket server — AND answer the three questions above?* If yes, Phase 1 is done.

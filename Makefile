.PHONY: dev-app dev-server lint-app lint-server test-server

dev-app:
	pnpm run tauri dev

dev-server:
	cd server && go run main.go

lint-app:
	pnpm run lint
	cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

lint-server:
	cd server && golangci-lint run ./...

test-server:
	cd server && go test -race ./...
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
.PHONY: dev-app dev-server lint-app lint-server test-server

dev-app:
	pnpm run tauri dev

dev-app-2:
	npm run tauri dev --config '{"build": { "devPath": "http://localhost:1421"}}'

dev-server:
	cd server && go run main.go

lint-app:
	pnpm run check
	cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

test-app:
	npm run test:app

lint-server:
	cd server && golangci-lint run ./...

test-server:
	cd server && go test -race ./...
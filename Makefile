.PHONY: dev build test release
dev:
	go build -trimpath -o bin/sift-development ./cmd/sift
	bin/sift-development serve --data .sift-dev --port 57432
build:
	cd web && npm ci && npm run build
	go build -trimpath -o bin/sift-development ./cmd/sift
test:
	go test -race ./...
	cd web && npm run build && npm test
release:
	@test -n "$(VERSION)" || (echo "Use make release VERSION=0.1.0"; exit 1)
	python3 scripts/collect-licenses.py
	python3 scripts/release.py --version "$(VERSION)"

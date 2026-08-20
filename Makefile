# Convenience wrapper around scripts/dev-runner.ts.
#
# The repo's own entry points are `vp run …` / `pnpm …`; this exists so the
# LAN-accessible dev configuration is one word instead of a remembered flag
# string. Everything here shells out to the same scripts, so nothing diverges.

# node_modules/.bin holds vp, tsgo, vitest and friends. The dev runner spawns
# `vp` by name, so it has to be on PATH or `make dev` dies with ENOENT.
export PATH := $(CURDIR)/node_modules/.bin:$(PATH)

# Namespaced on purpose. Plain HOST/HOME_DIR are common in shell profiles, and
# make treats an inherited environment variable as already set, so `?=` would
# silently lose to it — binding dev to loopback exactly when you asked for LAN.
# Override on the command line: `make dev T3_HOME_DIR=/tmp/t3-scratch`.
T3_HOME_DIR ?= $(HOME)/.t3
# Must stay a wildcard: single-origin dev proxies the backend at localhost, so
# binding only the LAN address leaves loopback unanswered and every proxied
# request fails.
T3_HOST ?= 0.0.0.0
# Set to 1 to start anyway when the guard trips on a stale record.
T3_FORCE ?= 0
# macOS sleeps on its own schedule (check `pmset -g custom | grep " sleep"`),
# and a sleeping Mac stops answering, which a phone sees as "server
# disconnected". caffeinate holds an idle/system-sleep assertion for as long as
# the server runs; the display may still sleep and the screen may still lock,
# which is what you want. Closing the lid sleeps anyway. Set T3_AWAKE=0 to opt out.
T3_AWAKE ?= 1
# arm64 for Apple Silicon, x64 for Intel, universal for both (slower).
T3_ARCH ?= $(if $(filter arm64,$(shell uname -m)),arm64,x64)
AWAKE := $(if $(filter 1,$(T3_AWAKE)),caffeinate -ims,)
LAN_IP := $(shell ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $$1}')

.PHONY: help guard build-app app dmg dev lan dev-local dev-desktop dev-share pair ip install check test typecheck lint fmt

help: ## Show available targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}'

# Three separate things have to line up for a phone to reach this, and the
# runner's --host only covers the first:
#   --host                   → backend binds the wildcard
#   HOST                     → Vite binds the wildcard too (it defaults to
#                              localhost, and honours the plain HOST env var)
#   T3CODE_DEV_ALLOWED_HOSTS → Vite otherwise rejects any Host header that is
#                              not localhost or *.ts.net, which is what makes
#                              "swap localhost for the LAN IP" fail
# Setting HOST also pins Vite's HMR socket to that host, so hot reload will not
# reach the phone. The page loads; you refresh by hand.
# Nothing in the server refuses a second instance, and the dev runner quietly
# picks different ports when the usual ones are taken — so two stacks against
# one home both start, both write the same SQLite, and both overwrite the
# server-runtime.json the CLI reads to find "the" server. The failures that
# follow look like anything except the cause. Refuse instead.
# Bypass with `make dev T3_FORCE=1` when you know the record is stale.
guard:
	@state="$(T3_HOME_DIR)/userdata/server-runtime.json"; \
	if [ "$(T3_FORCE)" != "1" ] && [ -f "$$state" ]; then \
	  pid=$$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pid",""))' "$$state" 2>/dev/null); \
	  origin=$$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("devUrl") or json.load(open(sys.argv[1])).get("origin",""))' "$$state" 2>/dev/null); \
	  if [ -n "$$pid" ] && kill -0 "$$pid" 2>/dev/null; then \
	    echo "[make] A T3 Code server is already running against $(T3_HOME_DIR)"; \
	    echo "[make]   pid $$pid, serving $$origin"; \
	    echo "[make] Stop it first, or start this one on its own data:"; \
	    echo "[make]   make $(MAKECMDGOALS) T3_HOME_DIR=/tmp/t3-scratch"; \
	    exit 1; \
	  fi; \
	fi

# Browser dev with hot reload. Loopback only, and not fixable with a flag: the
# runner deletes HOST before starting Vite (scripts/dev-runner.ts:359) so an
# inherited one cannot pin Vite's HMR socket. Use `make lan` for a phone.
dev: guard ## Dev stack with hot reload, on this machine only
	$(AWAKE) node scripts/dev-runner.ts dev --home-dir $(T3_HOME_DIR)

# Phone/LAN access. Vite is loopback-only in every dev mode, so this skips it:
# build the client and let the backend serve it, putting the UI and the API on
# one origin the phone can reach. The build must run with VITE_HTTP_URL and
# VITE_WS_URL unset, or the client is pinned to 127.0.0.1 — the page loads on
# the phone and then silently dials the phone's own localhost.
# No hot reload: re-run to pick up changes.
lan: guard ## Phone/LAN access on one origin (builds the client, no hot reload)
	env -u VITE_HTTP_URL -u VITE_WS_URL -u HOST \
		vp run --filter @t3tools/web build
	$(AWAKE) node apps/server/src/bin.ts serve --base-dir $(T3_HOME_DIR) --host $(T3_HOST)

dev-local: guard ## Dev stack on loopback only
	$(AWAKE) node scripts/dev-runner.ts dev --home-dir $(T3_HOME_DIR)

dev-desktop: guard ## Electron app. Loopback only by design — not reachable from a phone.
	$(AWAKE) node scripts/dev-runner.ts dev:desktop --home-dir $(T3_HOME_DIR)

dev-share: guard ## Dev stack published on the tailnet, prints a pairing URL
	$(AWAKE) node scripts/dev-runner.ts dev --home-dir $(T3_HOME_DIR) --share

# The desktop app, built from this checkout so it carries local changes.
# The build must run with VITE_HTTP_URL/VITE_WS_URL unset: with them set (as
# `dev:desktop` sets them) the bundled client is pinned to 127.0.0.1 and is
# unusable from a phone, while still loading fine on this machine.
build-app: ## Build the desktop app and its server from this checkout
	env -u VITE_HTTP_URL -u VITE_WS_URL -u HOST \
		vp run --filter @t3tools/desktop --filter t3 build
	@echo "[make] verifying the bundled client is origin-relative..."
	@if grep -qho "127\.0\.0\.1:13[0-9]*" apps/server/dist/client/assets/*.js 2>/dev/null; then \
		echo "[make] FAIL: the bundled client has a loopback origin baked in."; \
		echo "[make] It would load on this Mac and silently fail on every other device."; \
		exit 1; \
	fi
	@echo "[make] ok — client resolves its API from the serving origin"

app: guard ## Run the built desktop app (build-app first)
	@test -f apps/desktop/dist-electron/main.cjs || { echo "[make] Not built yet — run 'make build-app'"; exit 1; }
	$(AWAKE) vp run --filter @t3tools/desktop start

# --skip-build on purpose: build-app has already built the desktop and server,
# and verified the bundled client is not pinned to loopback. Rebuilding here
# would discard the artifact that check actually looked at.
# Unsigned: --signed needs Apple credentials. macOS will need a right-click →
# Open the first time.
dmg: build-app ## Package an installable .dmg for /Applications
	node scripts/build-desktop-artifact.ts \
		--platform mac --target dmg --arch $(T3_ARCH) --skip-build

pair: ## Mint a fresh pairing token for the running server and print it as a QR code
	node apps/server/src/bin.ts pair --base-dir $(T3_HOME_DIR)

ip: ## Print this machine's LAN address
	@echo $(LAN_IP)

install: ## Install workspace dependencies
	vp i

check: typecheck lint ## Typecheck and lint everything (CI owns the full suite)

test: ## Run the full test suite
	vp run -r test

typecheck: ## Typecheck every package
	vp run -r --concurrency-limit 2 typecheck

lint: ## Lint the workspace
	vp lint --report-unused-disable-directives

fmt: ## Format the workspace
	vp fmt

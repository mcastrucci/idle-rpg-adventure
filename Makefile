# Self-hosting shortcuts for Linux, macOS or WSL (see docs/ops/self-host-tunnel.md).
# On Windows without make, use scripts/selfhost/up.ps1 and down.ps1 instead.
.PHONY: selfhost selfhost-staging selfhost-update selfhost-down selfhost-logs

selfhost: ## Start the game behind a Cloudflare quick tunnel
	scripts/selfhost/up.sh

selfhost-staging: ## Same, with the staging overlay and the debug panel
	scripts/selfhost/up.sh --staging

selfhost-update: ## git pull, rebuild, migrate and start in staging mode
	scripts/selfhost/up.sh --update --staging

selfhost-down: ## Stop the tunnel and the server (the database keeps its data)
	scripts/selfhost/down.sh

selfhost-logs: ## Follow the server logs
	docker compose logs -f server

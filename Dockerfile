FROM node:24-bookworm-slim

ENV APP_ENV=production \
    RPG_DEBUG_TOOLS=0 \
    HOST=0.0.0.0 \
    PORT=3000 \
    CONTENT_BUNDLE_PATH=/app/dist/rpg-content.json

WORKDIR /app

# Keep the workspace intact: Node's built-in TypeScript support resolves the workspace
# package symlinks directly, and runtime migration SQL/meta files remain beside the app.
COPY . .

# Corepack reads packageManager from package.json, pinning pnpm to 10.28.0.
RUN corepack enable \
    && pnpm install --frozen-lockfile \
    && pnpm content-cli build games/rpg/content \
      --game ./games/rpg/tools/content-plugin/src/index.ts \
      --out dist/rpg-content.json \
    && chown -R node:node /app

ENV NODE_ENV=production

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node --input-type=module -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Exec form makes Node PID 1 so Docker's SIGTERM reaches the server shutdown handler.
CMD ["node", "games/rpg/apps/server/src/main.ts"]

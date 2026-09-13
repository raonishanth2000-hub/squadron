# Squadron — one Node process, one dependency, one writable directory.
#
# The app is stateful: a SQLite file and the attachment bytes both live under
# /app/data, and the WebSocket server holds long-lived connections. That is why
# this is a container on an always-on host rather than a serverless function.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a source edit does not re-resolve the tree.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# The platform terminates TLS at its edge and forwards plain http, so the app
# must not try to serve its own self-signed certificate behind that.
ENV SQUADRON_HTTP=1
# No SQUADRON_NO_RUN here on purpose. server/run.js sandboxes execution with
# macOS sandbox-exec, so on Linux its own platform guard already refuses to run
# anything — and it gives the friendlier reason ("this server can only run code
# on macOS ... editing and sharing still work") than the env-var branch does.
# Safe either way: it refuses rather than running unprotected.

# Mount a persistent volume here. Without one, every deploy wipes the database
# and every attachment, which is the single most common way a hosted SQLite app
# quietly loses all its data.
VOLUME ["/app/data"]

# Most platforms inject PORT; 8080 is the fallback.
ENV PORT=8080
EXPOSE 8080

# Run as the image's unprivileged user, and make sure it owns the data dir.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "server/index.js"]

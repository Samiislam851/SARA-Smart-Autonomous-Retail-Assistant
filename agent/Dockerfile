# Agent server — Express + WS. AGENT_MODE=llm shells out to the `codex` CLI
# (LLM_BACKEND=codex) or the `claude` CLI (LLM_BACKEND=claude), which need
# ~/.codex/auth.json+config.toml / ~/.claude credentials mounted at runtime
# (see docker-compose.yml). The openai/anthropic/gemini backends need only an
# API key env var, no CLI/mount. Do NOT bake credentials into this image.
#
# Uses the image's built-in `node` user (uid 1000, node:20-slim) rather than
# creating a new user. Host `~/.codex` is typically owned by the host user at
# uid 1000 mode 0600 — a freshly `useradd`'d container user lands at uid 1001
# and gets permission-denied on both read and write against that mount. uid
# 1000 is by far the most common single-user Linux/macOS host uid, so reusing
# the pre-existing `node` user (also uid 1000) makes the mount work out of the
# box for the common case. If your host user is NOT uid 1000, either chown
# ~/.codex to 1000 or run the container with `user: "${UID}:${GID}"` in
# docker-compose.yml (see DEPLOY.md).

FROM node:20-slim

# Pin the codex CLI version found via `npm view @openai/codex version` at
# build time of this Dockerfile (2026-09-11).
RUN npm i -g @openai/codex@0.154.0
# Pin the claude CLI version found via `npm view @anthropic-ai/claude-code
# version` at build time of this Dockerfile (2026-09-11).
RUN npm i -g @anthropic-ai/claude-code@2.1.268

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# `node` user/group (uid/gid 1000) already exists in node:20-slim. HOME must
# be set so the codex CLI looks for ~/.codex/auth.json / config.toml, and the
# claude CLI looks for ~/.claude/.credentials.json, both under /home/node
# (matches the compose volume mount targets).
RUN mkdir -p /home/node/.codex /home/node/.claude \
  && chown -R node:node /app /home/node
ENV HOME=/home/node
USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "index.js"]

# Storefront — Next.js, standalone output.
#
# IMPORTANT: NEXT_PUBLIC_* vars are inlined into the client bundle at BUILD
# time, not read at container start. To point a built image at a different
# server URL you must rebuild with new --build-arg values (see
# scripts/tunnel-up.sh, which does exactly this).

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_AGENT_HTTP=http://localhost:4000
ARG NEXT_PUBLIC_AGENT_WS=ws://localhost:4000
ENV NEXT_PUBLIC_AGENT_HTTP=${NEXT_PUBLIC_AGENT_HTTP}
ENV NEXT_PUBLIC_AGENT_WS=${NEXT_PUBLIC_AGENT_WS}
ENV NEXT_TELEMETRY_DISABLED=1

# Ensure a public/ dir exists so the COPY in the runner stage below never
# fails, whether or not the source tree has one.
RUN mkdir -p public
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN useradd --create-home --home-dir /home/app --shell /bin/bash app

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

USER app
EXPOSE 3000

CMD ["node", "server.js"]

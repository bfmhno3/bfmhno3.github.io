FROM node:24-bookworm-slim

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate \
    && mkdir -p /workspace && chown -R node:node /workspace

USER node
WORKDIR /workspace
EXPOSE 4321

# MCP 中转站（broker）：以 `docker run -i` 为每个 stdio MCP 服务器起独立容器，并代连 streamable HTTP 服务器。
# 需挂载宿主 /var/run/docker.sock（等同宿主 root），故以 root 运行；只运行皇帝批准过的配置。
FROM node:24-slim AS build
WORKDIR /src
# 先只拷清单，依赖层可缓存
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/hub/package.json packages/hub/
COPY packages/gateway/package.json packages/gateway/
COPY packages/dept/package.json packages/dept/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/mcp/package.json packages/mcp/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retries 5 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000 \
 && npm ci --no-audit --no-fund
COPY . .
RUN node scripts/build.mjs mcp

FROM docker:28-cli AS docker-cli

FROM node:24-slim AS runtime
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
ENV NODE_ENV=production \
    PORT=8300 \
    MCP_STDIO_RUNNER=docker
WORKDIR /app
COPY --from=build /src/dist/mcp /app/dist/mcp
EXPOSE 8300
CMD ["node", "--enable-source-maps", "/app/dist/mcp/main.js"]

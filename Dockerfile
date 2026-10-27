# 朝廷单镜像多角色：ROLE=hub|gateway|dept（沙箱另见 docker/sandbox.Dockerfile）
FROM node:24-slim AS build
WORKDIR /src
# 先只拷清单，依赖层可缓存
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/hub/package.json packages/hub/
COPY packages/gateway/package.json packages/gateway/
COPY packages/dept/package.json packages/dept/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/web/package.json packages/web/
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retries 5 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000 \
 && npm ci --no-audit --no-fund
COPY . .
ARG BUILD_ROLES=""
RUN node scripts/build.mjs $BUILD_ROLES
# Web 构建失败不阻断镜像（hub 无静态页时仍可提供 API）；WEB_STRICT=1 时失败即中止
ARG WEB_STRICT=0
RUN if [ -f packages/web/package.json ]; then \
      npm -w @court/web run build || { [ "$WEB_STRICT" = "1" ] && exit 1; echo "⚠ Web 构建失败，镜像将不含前端" >&2; }; \
    fi \
 && mkdir -p packages/web/dist

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    CONFIG_DIR=/app/config \
    WEB_DIR=/app/web \
    ROLE=hub
WORKDIR /app
COPY --from=build /src/dist /app/dist
COPY --from=build /src/config /app/config
COPY --from=build /src/packages/web/dist /app/web
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod 0755 /app/entrypoint.sh && mkdir -p /data/hub-db && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8000 8080 8100
ENTRYPOINT ["/app/entrypoint.sh"]

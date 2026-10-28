# 将作监沙箱：无密钥、不在 court 网络；执行兵/工/刑部的命令与抓取。
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
RUN node scripts/build.mjs sandbox

FROM node:24-slim AS runtime
# 可选 Debian 镜像源（如 mirrors.aliyun.com），默认官方源
ARG DEBIAN_MIRROR=""
RUN if [ -n "$DEBIAN_MIRROR" ]; then sed -i "s|deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends bash python3 python3-venv git curl ca-certificates procps \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspaces
# 服务以 root 运行（compose 中 cap_drop ALL，只加回 CHOWN/DAC_OVERRIDE/FOWNER/SETUID/SETGID/KILL），
# 每个工作区的作业以独立 uid（SANDBOX_JOB_UID_BASE + 哈希）运行，目录 0700：
# 作业读不到服务进程环境（token）、杀不了服务、进不了别的工作区。
ENV NODE_ENV=production \
    SANDBOX_ROOT=/workspaces \
    SANDBOX_JOB_UID_BASE=20000 \
    PORT=8200
WORKDIR /app
COPY --from=build /src/dist/sandbox /app/dist/sandbox
VOLUME ["/workspaces"]
EXPOSE 8200
CMD ["node", "--enable-source-maps", "/app/dist/sandbox/main.js"]

# The self-hosted ValueDesk copier in a container.
#
#   docker build -t valuedesk-copier -f apps/executor/Dockerfile .        (from the repository root)
#   docker run -d --name copier -p 127.0.0.1:8799:8799 -v copier-data:/data valuedesk-copier
#   docker logs copier                                                    (the pairing code)
#
# The port is published on 127.0.0.1 only: the copier has no TLS of its own.
# Reach it from another machine through an SSH tunnel (README), never openly.
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/executor ./apps/executor
# the licence check the bundle runs (tools/bundle.mjs imports it)
COPY apps/web/tools ./apps/web/tools
RUN npm install --no-audit --no-fund --ignore-scripts esbuild@0.25.0 @noble/curves@1.7.0 @noble/hashes@1.6.1 \
 && node apps/executor/tools/bundle.mjs --out=/out

FROM node:24-alpine
RUN addgroup -S copier && adduser -S copier -G copier && mkdir /data && chown copier:copier /data
COPY --from=build /out/valuedesk-copier.mjs /app/valuedesk-copier.mjs
USER copier
ENV EXECUTOR_KIND=self EXECUTOR_DATA_DIR=/data HOST=0.0.0.0 PORT=8799
VOLUME /data
EXPOSE 8799
CMD ["node", "/app/valuedesk-copier.mjs"]

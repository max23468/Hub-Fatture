FROM node:26.8.1-trixie-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS debian-snapshot

ARG DEBIAN_SNAPSHOT=20260828T000000Z
RUN sed -i \
    -e "s|^URIs: http://deb.debian.org/debian$|URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}|" \
    -e "s|^URIs: http://deb.debian.org/debian-security$|URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}|" \
    /etc/apt/sources.list.d/debian.sources \
  && printf '%s\n' 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99snapshot

FROM debian-snapshot AS development

RUN npm install --global npm@12.0.2 \
  && apt-get update \
  && apt-get install --yes --no-install-recommends \
    libssl3t64=3.5.7-1~deb13u2 \
    libxml2-utils=2.12.7+dfsg+really2.9.14-2.1+deb13u3 \
    openssl-provider-legacy=3.5.7-1~deb13u2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

FROM development AS build

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && npm run build:server

FROM development AS production-dependencies

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && rm -rf node_modules/typescript node_modules/@typescript \
  && test ! -e node_modules/typescript \
  && test ! -e node_modules/@react-router/dev \
  && test ! -e node_modules/vite

FROM debian-snapshot AS runtime

ARG APP_COMMIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/max23468/Hub-Fatture" \
  org.opencontainers.image.revision=$APP_COMMIT_SHA

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    libssl3t64=3.5.7-1~deb13u2 \
    libxml2-utils=2.12.7+dfsg+really2.9.14-2.1+deb13u3 \
    openssl-provider-legacy=3.5.7-1~deb13u2 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 hub-fatture \
  && useradd --uid 10001 --gid hub-fatture --no-create-home --shell /usr/sbin/nologin hub-fatture \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY --chown=hub-fatture:hub-fatture package.json ./
COPY --chown=hub-fatture:hub-fatture --from=production-dependencies /workspace/node_modules ./node_modules
COPY --chown=hub-fatture:hub-fatture --from=build /workspace/build ./build
COPY --chown=hub-fatture:hub-fatture --from=build /workspace/build-server ./build-server
COPY --chown=hub-fatture:hub-fatture migrations ./migrations
COPY --chown=hub-fatture:hub-fatture schemas ./schemas

USER 10001:10001
EXPOSE 3000
CMD ["node", "node_modules/@react-router/serve/bin.cjs", "./build/server/index.js"]

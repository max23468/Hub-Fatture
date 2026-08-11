FROM node:26.7.0-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341 AS development

RUN npm install --global npm@12.0.2 \
  && apt-get update \
  && apt-get install --yes --no-install-recommends libxml2-utils \
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

FROM node:26.7.0-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341 AS runtime

ARG APP_COMMIT_SHA=unknown
LABEL org.opencontainers.image.source="https://github.com/max23468/Hub-Fatture" \
  org.opencontainers.image.revision=$APP_COMMIT_SHA

RUN apt-get update \
  && apt-get install --yes --no-install-recommends libxml2-utils \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 hub-fatture \
  && useradd --uid 10001 --gid hub-fatture --no-create-home --shell /usr/sbin/nologin hub-fatture

WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY --chown=hub-fatture:hub-fatture package.json ./
COPY --chown=hub-fatture:hub-fatture --from=production-dependencies /workspace/node_modules ./node_modules
COPY --chown=hub-fatture:hub-fatture --from=build /workspace/build ./build
COPY --chown=hub-fatture:hub-fatture --from=build /workspace/build-server ./build-server
COPY --chown=hub-fatture:hub-fatture migrations ./migrations

USER 10001:10001
EXPOSE 3000
CMD ["npm", "start"]

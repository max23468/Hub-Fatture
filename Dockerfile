FROM node:26.7.0-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341

RUN npm install --global npm@12.0.2 \
  && apt-get update \
  && apt-get install --yes --no-install-recommends libxml2-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

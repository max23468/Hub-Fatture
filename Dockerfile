FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb

RUN apt-get update \
  && apt-get install --yes --no-install-recommends libxml2-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

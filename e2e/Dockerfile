# QAuth's server image with this plugin added the way an operator adds it
# (QAuth's docs: operate/images, "Add a plugin to the image"). The plugin is
# the tarball `pnpm pack` made of this checkout, the same file npm would
# publish; run.sh puts it at .work/plugin.tgz.
#
# The plugin is installed nested, so it brings its own copy of the plugin SDK,
# without its peer dependencies, so it uses the server's zod, and without
# install scripts.
#
# TEMPORARY, until the plugin SDK release with the preset shape
# (qauth-labs/qauth#671) is on npm: the plugin depends on the SDK as a
# `file:` tarball (vendor/), which npm cannot resolve inside the image. So
# this stage unpacks the two tarballs where `npm install --omit=dev
# --omit=peer --install-strategy=nested --ignore-scripts /tmp/plugin.tgz`
# would put them: the plugin, and the SDK (which has no dependencies) nested
# under it. Once the SDK is on npm, this goes back to that `npm install`
# line, as plugin-github's e2e/Dockerfile has it.
#
# QAUTH_IMAGE is the server image (run.sh, compose.yml): until a QAuth
# release carries #671, the one e2e/qauth-images.sh builds from the commit
# e2e/qauth-commit names.
ARG QAUTH_IMAGE

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS plugin
WORKDIR /plugin
COPY .work/plugin.tgz /tmp/plugin.tgz
COPY .work/plugin-sdk.tgz /tmp/plugin-sdk.tgz
RUN set -eu; \
  target=/plugin/node_modules/@qauth-labs/plugin-google; \
  mkdir -p /plugin/node_modules/@qauth-labs /tmp/unpack/plugin /tmp/unpack/sdk; \
  tar -xzf /tmp/plugin.tgz -C /tmp/unpack/plugin; \
  mv /tmp/unpack/plugin/package "$target"; \
  mkdir -p "$target/node_modules/@qauth-labs"; \
  tar -xzf /tmp/plugin-sdk.tgz -C /tmp/unpack/sdk; \
  mv /tmp/unpack/sdk/package "$target/node_modules/@qauth-labs/plugin-sdk"; \
  rm -rf /tmp/unpack /tmp/plugin.tgz /tmp/plugin-sdk.tgz

FROM ${QAUTH_IMAGE}
COPY --from=plugin --chown=nodejs:nodejs \
  /plugin/node_modules/@qauth-labs/plugin-google \
  /app/node_modules/@qauth-labs/plugin-google

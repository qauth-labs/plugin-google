#!/usr/bin/env bash
# QAuth's auth-server and migration-runner images for the end-to-end suite,
# built from the one qauth commit e2e/qauth-commit names.
#
# TEMPORARY: no released QAuth image carries the plugin loader that builds a
# method from an upstream OpenID Connect preset (qauth-labs/qauth#671) yet.
# Once a release does, the suite runs that release's images, pinned by
# digest, as plugin-github's suite does, and this script goes away.
#
# When qauth-e2e/auth-server:<commit> and qauth-e2e/migration-runner:<commit>
# are both present, it does nothing. Otherwise it fetches that commit, and
# only that commit, into e2e/.work-qauth/ and builds both images from its
# Dockerfiles with the qauth checkout as the context. The two share their
# first stage, so the second build reuses the first one's install.
#
# Needs git and docker (with BuildKit, the default since Docker 23).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
commit="$(tr -d '[:space:]' < "$here/qauth-commit")"
if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "e2e/qauth-commit must hold one full commit id, not '$commit'" >&2
  exit 1
fi
server="qauth-e2e/auth-server:$commit"
migration="qauth-e2e/migration-runner:$commit"

if docker image inspect "$server" > /dev/null 2>&1 \
  && docker image inspect "$migration" > /dev/null 2>&1; then
  echo "QAuth's images for $commit are present: $server, $migration"
  exit 0
fi

src="$here/.work-qauth"
rm -rf "$src"
mkdir -p "$src"
git -C "$src" -c init.defaultBranch=e2e init --quiet
git -C "$src" remote add origin https://github.com/qauth-labs/qauth.git
git -C "$src" fetch --quiet --depth 1 origin "$commit"
git -C "$src" -c advice.detachedHead=false checkout --quiet FETCH_HEAD
if [ "$(git -C "$src" rev-parse HEAD)" != "$commit" ]; then
  echo "the fetched checkout is not $commit" >&2
  exit 1
fi

echo "Building $server"
docker build --file "$src/apps/auth-server/Dockerfile" --tag "$server" "$src"
echo "Building $migration"
docker build --file "$src/apps/migration-runner/Dockerfile" --tag "$migration" "$src"

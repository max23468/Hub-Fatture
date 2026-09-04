#!/bin/sh
set -eu

commit=${1:-}
publish_release=${2:-}

if [ "${#commit}" -ne 40 ]; then
  echo "Uso: scripts/dispatch-production.sh <commit-main-40-caratteri> [true|false]" >&2
  exit 2
fi
case "$commit" in
  *[!0-9a-f]*)
    echo "Il commit deve essere uno SHA-1 completo in caratteri minuscoli." >&2
    exit 2
    ;;
esac

repository=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
default_branch=$(gh api "repos/$repository" --jq .default_branch)
remote_commit=$(gh api "repos/$repository/commits/$commit" --jq .sha)
test "$remote_commit" = "$commit"

if [ -z "$publish_release" ]; then
  publish_release=true
fi
case "$publish_release" in
  true | false) ;;
  *)
    echo "publish_release deve essere true oppure false" >&2
    exit 2
    ;;
esac

comparison=$(gh api "repos/$repository/compare/$commit...$default_branch" --jq .status)
case "$comparison" in
  identical | ahead) ;;
  *)
    echo "Il commit non appartiene alla linea corrente di $default_branch." >&2
    exit 1
    ;;
esac

gh workflow run Production \
  --repo "$repository" \
  --ref "$default_branch" \
  -f commit="$commit" \
  -f backup_only=false \
  -f publish_release="$publish_release"

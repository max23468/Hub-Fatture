#!/bin/sh
set -eu

commit=${1:-}
mode=${2:-}
printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' \
  || { echo "Uso: $0 <commit-live-40-caratteri> <enable|disable>" >&2; exit 2; }
case "$mode" in
  enable | disable) ;;
  *) echo "Uso: $0 <commit-live-40-caratteri> <enable|disable>" >&2; exit 2 ;;
esac

repository=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
default_branch=$(gh api "repos/$repository" --jq .default_branch)
remote_commit=$(gh api "repos/$repository/commits/$commit" --jq .sha)
[ "$remote_commit" = "$commit" ] || { echo "Commit remoto inatteso" >&2; exit 1; }

if [ "$mode" = enable ]; then
  version=$(gh api "repos/$repository/contents/package.json?ref=$commit" \
    --jq .content | base64 --decode | jq -er .version)
  printf '%s' "$version" | grep -Eq '^[1-9][0-9]*\.[0-9]+\.[0-9]+$' \
    || { echo "L'uso ordinario richiede una release stabile" >&2; exit 1; }
  release=$(gh release view "v$version" --repo "$repository" \
    --json isDraft,isImmutable,isPrerelease,targetCommitish)
  printf '%s' "$release" | jq -e --arg commit "$commit" '
    .isDraft == false and .isImmutable == true and .isPrerelease == false and
    .targetCommitish == $commit
  ' >/dev/null || { echo "Release immutabile non conforme al candidato" >&2; exit 1; }
fi

gh workflow run "Production submission mode" \
  --repo "$repository" \
  --ref "$default_branch" \
  -f commit="$commit" \
  -f mode="$mode"

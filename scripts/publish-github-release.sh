#!/bin/sh
set -eu

if [ "$#" -ne 4 ]; then
  echo "Uso: $0 <tag> <commit> <manifest-json> <note-md>" >&2
  exit 2
fi

tag=$1
commit=$2
manifest=$3
notes=$4

case "$tag" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "Tag release non valido: $tag" >&2; exit 2 ;;
esac
printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || {
  echo "Commit release non valido" >&2
  exit 2
}
[ -f "$manifest" ] || { echo "Manifest release assente" >&2; exit 2; }
[ -f "$notes" ] || { echo "Note release assenti" >&2; exit 2; }

version=${tag#v}
[ "$(jq -r '.version // empty' "$manifest")" = "$version" ] || {
  echo "Versione manifest diversa dal tag" >&2
  exit 2
}
[ "$(jq -r '.commit // empty' "$manifest")" = "$commit" ] || {
  echo "Commit manifest diverso dal candidato" >&2
  exit 2
}
jq -e '
  (.imageDigest | test("^sha256:[0-9a-f]{64}$")) and
  (.rollbackDigest | test("^sha256:[0-9a-f]{64}$")) and
  (.schema | test("^[0-9]{3}_[A-Za-z0-9_]+[.]sql$")) and
  (.attestation | test("^https://github[.]com/"))
' "$manifest" >/dev/null || {
  echo "Manifest release incompleto o non valido" >&2
  exit 2
}

repository=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
if gh release view "$tag" --repo "$repository" >/dev/null 2>&1; then
  echo "La release $tag esiste già e non viene modificata" >&2
  exit 1
fi

resolve_remote_tag() {
  refs=$(gh api "repos/$repository/git/matching-refs/tags/$tag") || return 2
  ref=$(printf '%s' "$refs" | jq -c --arg expected "refs/tags/$tag" \
    '[.[] | select(.ref == $expected)]') || return 2
  ref_count=$(printf '%s' "$ref" | jq -r length) || return 2
  [ "$ref_count" -gt 0 ] || return 1
  [ "$ref_count" -eq 1 ] || {
    echo "Il tag remoto non è univoco" >&2
    return 2
  }
  ref=$(printf '%s' "$ref" | jq -c '.[0]') || return 2
  object_type=$(printf '%s' "$ref" | jq -r .object.type)
  object_sha=$(printf '%s' "$ref" | jq -r .object.sha)
  depth=0
  while [ "$object_type" = "tag" ]; do
    depth=$((depth + 1))
    [ "$depth" -le 8 ] || {
      echo "Catena del tag remoto troppo profonda" >&2
      return 2
    }
    ref=$(gh api "repos/$repository/git/tags/$object_sha") || return 2
    object_type=$(printf '%s' "$ref" | jq -r .object.type)
    object_sha=$(printf '%s' "$ref" | jq -r .object.sha)
  done
  [ "$object_type" = "commit" ] || {
    echo "Il tag remoto non risolve a un commit" >&2
    return 2
  }
  printf '%s\n' "$object_sha"
}

if remote_tag_commit=$(resolve_remote_tag); then
  [ "$remote_tag_commit" = "$commit" ] || {
    echo "Il tag remoto $tag punta a un commit diverso dal candidato" >&2
    exit 1
  }
else
  tag_status=$?
  [ "$tag_status" -eq 1 ] || exit "$tag_status"
fi

stage_dir=$(mktemp -d "${TMPDIR:-/tmp}/hub-fatture-release.XXXXXX")
case "$stage_dir" in
  "${TMPDIR:-/tmp}"/hub-fatture-release.*) ;;
  *) echo "Directory temporanea inattesa" >&2; exit 1 ;;
esac
release_id=
cleanup() {
  status=$?
  if [ -n "$release_id" ]; then
    draft=$(gh api "repos/$repository/releases/$release_id" --jq .draft 2>/dev/null || true)
    if [ "$draft" = "true" ]; then
      gh api -X DELETE "repos/$repository/releases/$release_id" >/dev/null 2>&1 || \
        echo "Pulizia della draft release non riuscita" >&2
    fi
  fi
  rm -rf -- "$stage_dir"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM
install -m 600 "$manifest" "$stage_dir/release-manifest.json"

gh release create "$tag" "$stage_dir/release-manifest.json" \
  --repo "$repository" \
  --target "$commit" \
  --title "Hub Fatture $version" \
  --notes-file "$notes" \
  --draft >/dev/null

draft_release=$(gh release view "$tag" --repo "$repository" \
  --json databaseId,tagName,isDraft,isPrerelease,targetCommitish,assets)
release_id=$(printf '%s' "$draft_release" | jq -r .databaseId)
printf '%s' "$draft_release" | jq -e \
  --arg tag "$tag" \
  --arg commit "$commit" '
    .tagName == $tag and
    .targetCommitish == $commit and
    .isDraft == true and
    .isPrerelease == false and
    ([.assets[].name] == ["release-manifest.json"])
  ' >/dev/null || {
  echo "Verifica della draft release non conforme" >&2
  exit 1
}

gh release edit "$tag" --repo "$repository" --draft=false --latest >/dev/null

[ "$(resolve_remote_tag)" = "$commit" ] || {
  echo "Il tag pubblicato non punta al commit candidato" >&2
  exit 1
}

release=$(gh release view "$tag" --repo "$repository" \
  --json tagName,isDraft,isPrerelease,isImmutable,targetCommitish,assets,url)
printf '%s' "$release" | jq -e \
  --arg tag "$tag" \
  --arg commit "$commit" '
    .tagName == $tag and
    .targetCommitish == $commit and
    .isDraft == false and
    .isPrerelease == false and
    .isImmutable == true and
    ([.assets[].name] == ["release-manifest.json"])
  ' >/dev/null || {
  echo "Readback della release non conforme" >&2
  exit 1
}
release_id=
printf '%s\n' "$release" | jq -r .url

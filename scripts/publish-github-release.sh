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

stage_dir=$(mktemp -d "${TMPDIR:-/tmp}/hub-fatture-release.XXXXXX")
case "$stage_dir" in
  "${TMPDIR:-/tmp}"/hub-fatture-release.*) ;;
  *) echo "Directory temporanea inattesa" >&2; exit 1 ;;
esac
cleanup() {
  rm -rf -- "$stage_dir"
}
trap cleanup EXIT HUP INT TERM
install -m 600 "$manifest" "$stage_dir/release-manifest.json"

gh release create "$tag" "$stage_dir/release-manifest.json" \
  --repo "$repository" \
  --target "$commit" \
  --title "Hub Fatture $version" \
  --notes-file "$notes" \
  --latest >/dev/null

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
printf '%s\n' "$release" | jq -r .url

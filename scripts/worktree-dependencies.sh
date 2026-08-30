#!/bin/sh
set -eu

target=${1:-$(pwd)}
root=$(git -C "$target" rev-parse --show-toplevel)
common_dir=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)

if [ "$(basename "$common_dir")" != ".git" ]; then
  echo "Directory Git comune inattesa: $common_dir" >&2
  exit 1
fi

primary_root=$(CDPATH='' cd -- "$(dirname -- "$common_dir")" && pwd)
current_modules="$root/node_modules"
primary_modules="$primary_root/node_modules"

if [ "$root" = "$primary_root" ]; then
  if [ -d "$current_modules" ]; then
    echo "Dipendenze già disponibili nel checkout principale."
    exit 0
  fi
  cd "$root"
  npm ci --no-audit --prefer-offline
  exit 0
fi

same_lock=false
if [ -f "$root/package-lock.json" ] && [ -f "$primary_root/package-lock.json" ] \
  && cmp -s "$root/package-lock.json" "$primary_root/package-lock.json"; then
  same_lock=true
fi

if [ "$same_lock" = true ] && [ -d "$primary_modules" ]; then
  if [ -L "$current_modules" ]; then
    linked_modules=$(readlink "$current_modules")
    if [ "$linked_modules" = "$primary_modules" ]; then
      echo "Dipendenze condivise già allineate."
      exit 0
    fi
    rm "$current_modules"
  elif [ -d "$current_modules" ]; then
    echo "Dipendenze locali già disponibili nel worktree."
    exit 0
  elif [ -e "$current_modules" ]; then
    echo "node_modules esiste ma non è una directory o un collegamento valido." >&2
    exit 1
  fi
  ln -s "$primary_modules" "$current_modules"
  echo "Dipendenze condivise dal checkout principale."
  exit 0
fi

if [ -L "$current_modules" ]; then
  rm "$current_modules"
elif [ -e "$current_modules" ] && [ ! -d "$current_modules" ]; then
  echo "node_modules esiste ma non è una directory o un collegamento valido." >&2
  exit 1
fi

cd "$root"
npm ci --no-audit --prefer-offline
echo "Dipendenze dedicate installate nel worktree."

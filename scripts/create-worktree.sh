#!/bin/sh
set -eu

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "Uso: scripts/create-worktree.sh <branch> <percorso> [base]" >&2
  exit 2
fi

branch=$1
target=$2
base=${3:-main}
root=$(git rev-parse --show-toplevel)

git -C "$root" worktree add -b "$branch" "$target" "$base"
sh "$root/scripts/worktree-dependencies.sh" "$target"

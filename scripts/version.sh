#!/usr/bin/env bash
# The app version, kept in sync everywhere it is written down.
#
#   scripts/version.sh get              print the version (app/src-tauri/tauri.conf.json is the source)
#   scripts/version.sh check            print every place the version lives; exit 1 if any differs
#   scripts/version.sh next <patch|minor|major|X.Y.Z>   print the version a bump would give
#   scripts/version.sh set <X.Y.Z>      write X.Y.Z everywhere, then check
#   scripts/version.sh files            list the files that hold the version
#
# Places: tauri.conf.json, app/package.json, app/src-tauri/Cargo.toml (+ its Cargo.lock entry),
# pyproject.toml (+ its uv.lock entry), website/package.json and DOWNLOAD.version in
# website/components/site.ts. The lock entries are edited in place (no network, no re-resolve).
#
# Versions are plain X.Y.Z: Cargo, npm and PEP 440 spell pre-releases differently.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FILES=(
  app/src-tauri/tauri.conf.json
  app/package.json
  app/src-tauri/Cargo.toml
  app/src-tauri/Cargo.lock
  pyproject.toml
  uv.lock
  website/package.json
  website/components/site.ts
)

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }
die() { printf 'version.sh: %s\n' "$*" >&2; exit 1; }

is_semver() { [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; }

# Each place is read and written by an awk program that finds one line. `mode=get` prints the
# version on that line; `mode=set` rewrites it and prints the whole file.
#   json      the first top-level-looking "version": "..." line (2-space indented)
#   toml      the version = "..." line in the first [package]/[project] table
#   lock      the version = "..." line right after name = "manga-studio" (Cargo.lock, uv.lock)
#   site      version: "..." inside `export const DOWNLOAD = {`
# shellcheck disable=SC2016 # awk code, not shell
AWK_PLACE='
function out(line) { if (mode == "set") print line }
{
  hit = 0
  if (kind == "json" && !done && $0 ~ /^  "version": *"[^"]*"/) hit = 1
  else if (kind == "toml") {
    if ($0 ~ /^\[(package|project)\]/) intable = 1
    else if ($0 ~ /^\[/) intable = 0
    if (intable && !done && $0 ~ /^version *= *"[^"]*"/) hit = 1
  } else if (kind == "lock") {
    if ($0 ~ /^name = "manga-studio"$/) want = 1
    else if (want && $0 ~ /^version = "[^"]*"/) { hit = 1; want = 0 }
    else if ($0 ~ /^\[\[package\]\]/) want = 0
  } else if (kind == "site") {
    if ($0 ~ /^export const DOWNLOAD *= *\{/) indl = 1
    else if (indl && $0 ~ /^\};?/) indl = 0
    if (indl && !done && $0 ~ /^ +version: *"[^"]*"/) hit = 1
  }
  if (hit && !done) {
    done = 1
    line = $0
    # the value is the last quoted string on the line: head "cur" tail
    match(line, /"[^"]*"[^"]*$/)
    head = substr(line, 1, RSTART)
    rest = substr(line, RSTART + 1)
    q = index(rest, "\"")
    cur = substr(rest, 1, q - 1)
    tail = substr(rest, q)
    if (mode == "get") { print cur; exit }
    out(head v tail)
    next
  }
  out($0)
}
END { if (!done) exit 3 }
'

kind_of() {
  case "$1" in
    *.json) echo json ;;
    *.lock) echo lock ;;
    *.toml) echo toml ;;
    *site.ts) echo site ;;
    *) die "no reader for $1" ;;
  esac
}

read_place() { # read_place <file>: print its version, or nothing
  awk -v kind="$(kind_of "$1")" -v mode=get "$AWK_PLACE" "$1" 2>/dev/null || true
}

write_place() { # write_place <file> <version>
  local file="$1" v="$2" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  if ! awk -v kind="$(kind_of "$file")" -v mode=set -v v="$v" "$AWK_PLACE" "$file" >"$tmp"; then
    /bin/rm -f "$tmp"
    die "couldn't find the version line in $file"
  fi
  # keep the file's mode (mktemp creates 0600)
  chmod "$(stat -f '%Lp' "$file")" "$tmp"
  mv -f "$tmp" "$file"
}

cmd_get() {
  local v
  v="$(read_place app/src-tauri/tauri.conf.json)"
  [[ -n "$v" ]] || die "no version in app/src-tauri/tauri.conf.json"
  echo "$v"
}

cmd_check() {
  local want f v bad=0 quiet="${1:-}"
  want="$(cmd_get)"
  for f in "${FILES[@]}"; do
    v="$(read_place "$f")"
    if [[ "$v" == "$want" ]]; then
      [[ -n "$quiet" ]] || printf '  %-10s %s\n' "$v" "$f"
    else
      printf '  %-10s %s  (expected %s)\n' "${v:-missing}" "$f" "$want" >&2
      bad=1
    fi
  done
  [[ $bad -eq 0 ]] || die "versions differ; fix with: scripts/version.sh set $want"
}

cmd_next() {
  local spec="${1:?next needs patch, minor, major or X.Y.Z}" cur major minor patch
  cur="$(cmd_get)"
  is_semver "$cur" || die "current version '$cur' isn't X.Y.Z"
  IFS=. read -r major minor patch <<<"$cur"
  case "$spec" in
    patch) echo "$major.$minor.$((patch + 1))" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    major) echo "$((major + 1)).0.0" ;;
    *)
      is_semver "$spec" || die "'$spec' isn't patch, minor, major or X.Y.Z"
      echo "$spec"
      ;;
  esac
}

cmd_set() {
  local v="${1:?set needs X.Y.Z}" f
  is_semver "$v" || die "'$v' isn't X.Y.Z"
  for f in "${FILES[@]}"; do [[ -f "$f" ]] || die "missing $f"; done
  for f in "${FILES[@]}"; do write_place "$f" "$v"; done
  cmd_check quiet
}

case "${1:-}" in
  get) cmd_get ;;
  check) cmd_check ;;
  next) shift; cmd_next "$@" ;;
  set) shift; cmd_set "$@" ;;
  files) printf '%s\n' "${FILES[@]}" ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# One command from main to a published, notarized GitHub release of Manga Studio for macOS.
#
#   scripts/deploy.sh <patch|minor|major|X.Y.Z> [--yes] [--dry-run] [--notes-file FILE]
#   scripts/deploy.sh verify [X.Y.Z]     re-run the after-publish checks for a release
#
# What it does:
#   1. Preflight: on main, clean tree, main not behind origin, the tag and release are free,
#      gh logged in, Developer ID identity, notary profile, tests, app build, website build.
#   2. Bumps the version everywhere (scripts/version.sh set).
#   3. CHANGELOG.md: moves ## [Unreleased] into ## [X.Y.Z] - today (scripts/changelog.sh release);
#      if Unreleased is empty it drafts the section from commit subjects and opens $EDITOR.
#   4. Commits "Release vX.Y.Z", pushes main, runs scripts/release-mac.sh --publish (build, sign,
#      notarize, staple, DMG, GitHub release + tag), then fetches the tag.
#   5. Checks the release has its assets and that /releases/latest/download/ serves it.
#
# Passing the current version (e.g. 0.2.0 when it has a CHANGELOG section but no tag yet)
# releases it as is, with no bump.
#
# Options:
#   --yes             don't stop for review (no editor, no prompt)
#   --dry-run         preflight (the notary check only warns), show the bump and the notes, run
#                     release-mac.sh --dry-run, then put every changed file back. No commit, no push.
#   --notes-file F    use F as the GitHub release notes instead of the CHANGELOG section
#                     (CHANGELOG.md is still updated)
#
# Environment: NOTARY_PROFILE (default manga-studio-notary), SIGNING_IDENTITY, VISUAL/EDITOR.
# Secrets are never printed: notarytool and gh read them from the keychain.

set -euo pipefail

TEAM_ID="38QXSRV6AP"
NOTARY_PROFILE="${NOTARY_PROFILE:-manga-studio-notary}"
STABLE_DMG="Manga-Studio-macOS-arm64.dmg"

usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  ok    %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*"; }
FAILS=()
fail() { printf '  FAIL  %s\n' "$*"; FAILS+=("$1"); }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

repo_slug() {
  local u
  u="$(git remote get-url origin 2>/dev/null || true)"
  u="${u%.git}"
  u="${u#https://github.com/}"
  u="${u#git@github.com:}"
  echo "${u:-Himasnhu-AT/manga-studio}"
}
REPO="$(repo_slug)"

# ---------------------------------------------------------------------------------------------
# After publish: the release has its assets and /releases/latest/download/ points at it.
verify_release() { # verify_release <X.Y.Z>
  local v="$1" tag="v$1" names url latest code loc bad=0
  bold "Verify $tag"
  if ! names="$(gh release view "$tag" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null)"; then
    printf '  FAIL  no GitHub release %s\n' "$tag"
    return 1
  fi
  for a in "$STABLE_DMG" "Manga-Studio-$v-macOS-arm64.dmg" SHA256SUMS.txt; do
    if grep -qxF "$a" <<<"$names"; then ok "asset $a"; else printf '  FAIL  asset %s missing\n' "$a"; bad=1; fi
  done
  latest="https://github.com/$REPO/releases/latest/download/$STABLE_DMG"
  read -r code loc < <(curl -sI -o /dev/null -w '%{http_code} %{redirect_url}\n' "$latest" || echo "000 -")
  if [[ "$code" =~ ^30[12378]$ && "$loc" == *"/releases/download/$tag/$STABLE_DMG"* ]]; then
    ok "latest download redirects to $tag ($code)"
  elif [[ "$code" =~ ^30[12378]$ ]]; then
    printf '  FAIL  %s redirects to %s, not %s (is the release a draft or pre-release?)\n' "$latest" "$loc" "$tag"
    bad=1
  else
    printf '  FAIL  %s answered %s\n' "$latest" "$code"
    bad=1
  fi
  url="$(gh release view "$tag" --repo "$REPO" --json url --jq .url)"
  echo
  bold "Release: $url"
  return $bad
}

if [[ "${1:-}" == "verify" ]]; then
  shift
  verify_release "${1:-$(scripts/version.sh get)}"
  exit $?
fi

# ---------------------------------------------------------------------------------------------
SPEC=""
YES=0
DRY_RUN=0
NOTES_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --notes-file) NOTES_FILE="${2:?--notes-file needs a path}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) [[ -z "$SPEC" ]] || { echo "one version at a time" >&2; exit 2; }; SPEC="$1" ;;
  esac
  shift
done
[[ -n "$SPEC" ]] || { usage >&2; exit 2; }
if [[ -n "$NOTES_FILE" ]]; then
  [[ -s "$NOTES_FILE" ]] || die "notes file $NOTES_FILE is missing or empty"
  NOTES_FILE="$(cd "$(dirname "$NOTES_FILE")" && pwd)/$(basename "$NOTES_FILE")"
fi

# Dry-run softens the checks that only matter for publishing.
soft() { if [[ $DRY_RUN -eq 1 ]]; then warn "$1 (ignored in --dry-run)"; else fail "$1"; fi; }

version_gt() { # version_gt A B: A > B
  [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" == "$1" ]]
}

# ---------------------------------------------------------------------------------------------
bold "Preflight"

for cmd in git gh node pnpm uv cargo xcrun security curl memgate; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing command: $cmd"
done
[[ ${#FAILS[@]} -eq 0 ]] || die "${#FAILS[@]} check(s) failed"

if VCHECK="$(scripts/version.sh check 2>&1)"; then
  CUR="$(scripts/version.sh get)"
  ok "current version $CUR in every file"
else
  printf '%s\n' "$VCHECK" | sed 's/^/      /'
  die "versions differ; fix them first (scripts/version.sh set X.Y.Z)"
fi
NEW="$(scripts/version.sh next "$SPEC")"
TAG="v$NEW"
SAME=0
if [[ "$NEW" == "$CUR" ]]; then
  if [[ -n "$(scripts/changelog.sh section "$NEW")" ]]; then
    SAME=1
    ok "releasing $NEW as is (no bump; CHANGELOG has its section)"
  else
    fail "$NEW is the current version and CHANGELOG.md has no section for it"
  fi
elif version_gt "$NEW" "$CUR"; then
  ok "new version $CUR -> $NEW"
else
  fail "$NEW isn't newer than $CUR"
fi

# git
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" == "main" ]]; then ok "on main"; else soft "on branch $BRANCH, not main"; fi
if [[ -z "$(git status --porcelain)" ]]; then ok "git tree clean"; else soft "git tree has uncommitted changes"; fi
if git fetch -q origin 2>/dev/null; then
  if git rev-parse -q --verify origin/main >/dev/null; then
    BEHIND="$(git rev-list --count HEAD..origin/main)"
    AHEAD="$(git rev-list --count origin/main..HEAD)"
    if [[ "$BEHIND" -gt 0 ]]; then
      soft "HEAD is $BEHIND commit(s) behind origin/main (git pull --ff-only)"
    else
      ok "not behind origin/main ($AHEAD local commit(s) to push)"
    fi
  else
    ok "origin has no main yet (first push)"
  fi
else
  soft "git fetch origin failed"
fi
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  fail "tag $TAG already exists locally"
elif git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  fail "tag $TAG already exists on origin"
else
  ok "tag $TAG is free"
fi

# GitHub
if gh auth status >/dev/null 2>&1; then
  ok "gh is logged in"
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    fail "GitHub release $TAG already exists"
  else
    ok "no GitHub release $TAG yet"
  fi
else
  soft "gh isn't logged in (run: gh auth login)"
fi

# Signing and notarization
IDENTITY="${SIGNING_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -n "s/.*\"\(Developer ID Application: .*($TEAM_ID)\)\"/\1/p" | head -1)}"
if [[ -n "$IDENTITY" ]] && security find-identity -v -p codesigning | grep -qF "\"$IDENTITY\""; then
  ok "signing identity: $IDENTITY"
else
  fail "no 'Developer ID Application: ... ($TEAM_ID)' identity in the keychain"
fi
if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  ok "notary profile $NOTARY_PROFILE works"
else
  soft "notarytool keychain profile '$NOTARY_PROFILE' doesn't work"
  cat <<EOF

        One-time setup, either with an app-specific password (appleid.apple.com > Sign-In and Security):
          xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <your Apple ID email> --team-id $TEAM_ID
        or with an App Store Connect API key (Users and Access > Integrations > Team Keys, role Developer):
          xcrun notarytool store-credentials $NOTARY_PROFILE --key <path/AuthKey_XXXX.p8> --key-id <KEY ID> --issuer <ISSUER UUID>
        notarytool prompts for the secret and keeps it in the login keychain.

EOF
fi

[[ ${#FAILS[@]} -eq 0 ]] || die "${#FAILS[@]} check(s) failed"

# ---------------------------------------------------------------------------------------------
WORK="$(mktemp -d -t manga-studio-deploy)"
BACKUP="$WORK/backup"
VFILES=()
while IFS= read -r f; do VFILES+=("$f"); done < <(scripts/version.sh files)
CHANGED=("${VFILES[@]}" CHANGELOG.md)
COMMITTED=0
STATUS=0

restore() { # put back every file this script may have changed (before the release commit)
  local f n=0
  [[ -d "$BACKUP" ]] || return 0
  for f in "${CHANGED[@]}"; do
    if ! cmp -s "$BACKUP/$f" "$f"; then /bin/cp -f "$BACKUP/$f" "$f"; n=$((n + 1)); fi
  done
  [[ $n -eq 0 ]] || echo "  restored $n file(s) to their state before deploy.sh"
}
cleanup() {
  STATUS=$?
  if [[ $COMMITTED -eq 0 ]]; then restore; fi
  if [[ $STATUS -eq 0 ]]; then /bin/rm -rf "$WORK"; else echo "  logs: $WORK" >&2; fi
}
trap cleanup EXIT

step() { # step <label> <command...>: run quietly into a log, show the tail on failure
  local label="$1" log
  shift
  log="$WORK/$(tr -c 'a-zA-Z0-9\n' '-' <<<"$label").log"
  printf '  ...   %s\r' "$label"
  if "$@" >"$log" 2>&1; then
    ok "$label"
  else
    printf '  FAIL  %s\n' "$label"
    tail -n 40 "$log" | sed 's/^/        /'
    die "$label failed (full log: $log)"
  fi
}

bold "Tests and builds"
step "backend tests (uv run pytest -q tests/)" env STUDIO_ENGINE=mock memgate -- uv run pytest -q tests/
step "app: pnpm install" bash -c 'cd app && pnpm install --frozen-lockfile'
step "app: typecheck and build (tsc -b, vite build)" bash -c 'cd app && memgate -- pnpm exec tsc -b && memgate -- pnpm exec vite build'
step "website: pnpm install" bash -c 'cd website && pnpm install --frozen-lockfile'
step "website: build (next build)" bash -c 'cd website && memgate -- pnpm build'
# The builds must not leave tracked files changed (they would end up in the release commit).
if [[ -n "$(git status --porcelain --untracked-files=no)" && $DRY_RUN -eq 0 ]]; then
  git status --short --untracked-files=no
  die "the builds changed tracked files; commit or revert them first"
fi

# ---------------------------------------------------------------------------------------------
bold "Version and changelog"
mkdir -p "$BACKUP"
for f in "${CHANGED[@]}"; do mkdir -p "$BACKUP/$(dirname "$f")"; /bin/cp -f "$f" "$BACKUP/$f"; done

if [[ $SAME -eq 0 ]]; then
  scripts/version.sh set "$NEW" >/dev/null
  ok "version $NEW in: $(scripts/version.sh files | tr '\n' ' ')"
fi

HOW="present"
if [[ -n "$(scripts/changelog.sh section "$NEW")" ]]; then
  ok "CHANGELOG.md already has a [$NEW] section"
  [[ -z "$(scripts/changelog.sh unreleased)" ]] || warn "notes under [Unreleased] stay there (they aren't part of $NEW)"
else
  HOW="$(scripts/changelog.sh release "$NEW")"
  if [[ "$HOW" == drafted ]]; then
    warn "[Unreleased] was empty: drafted [$NEW] from commit subjects (review it)"
  else
    ok "moved [Unreleased] into [$NEW] - $(date +%Y-%m-%d)"
  fi
fi

echo
git --no-pager diff --stat -- "${CHANGED[@]}"
echo
git --no-pager diff -U0 -- "${VFILES[@]}" | grep '^[-+][^-+]' | sed 's/^/    /' || true

show_notes() {
  echo
  bold "Release notes for $TAG$([[ -n "$NOTES_FILE" ]] && echo " (from $NOTES_FILE)")"
  if [[ -n "$NOTES_FILE" ]]; then cat "$NOTES_FILE"; else scripts/changelog.sh section "$NEW"; fi | sed 's/^/    /'
  echo
}

edit_changelog() {
  local editor="${VISUAL:-${EDITOR:-vi}}" ed
  read -ra ed <<<"$editor"
  "${ed[@]}" CHANGELOG.md </dev/tty >/dev/tty
}

if [[ $YES -eq 0 ]]; then
  [[ -r /dev/tty ]] || die "no terminal for the review; pass --yes"
  [[ "$HOW" != drafted || -n "$NOTES_FILE" ]] || edit_changelog
  while true; do
    show_notes
    printf 'Release %s with these notes? [y]es, [e]dit CHANGELOG.md, [n]o: ' "$TAG" >/dev/tty
    read -r answer </dev/tty
    case "$answer" in
      y|Y|yes) break ;;
      e|E|edit) edit_changelog ;;
      *) die "stopped; nothing committed (files restored)" ;;
    esac
  done
else
  show_notes
fi

# Re-check after any edit.
scripts/version.sh check >/dev/null 2>&1 || die "versions differ after the edit"
[[ -n "$(scripts/changelog.sh section "$NEW")" ]] || die "CHANGELOG.md has no [$NEW] section"
NOTES="$WORK/notes-$NEW.md"
if [[ -n "$NOTES_FILE" ]]; then /bin/cp -f "$NOTES_FILE" "$NOTES"; else scripts/changelog.sh section "$NEW" >"$NOTES"; fi

# ---------------------------------------------------------------------------------------------
if [[ $DRY_RUN -eq 1 ]]; then
  bold "release-mac.sh --dry-run (signed build of $NEW, no notarization, no upload)"
  scripts/release-mac.sh --dry-run
  echo
  restore
  [[ "$(scripts/version.sh get)" == "$CUR" ]] || die "restore failed: version is $(scripts/version.sh get)"
  bold "Dry run done: nothing committed, pushed, tagged or uploaded. Version is back to $CUR."
  exit 0
fi

resume_help() { # resume_help <what failed>
  local nf=""
  [[ -z "$NOTES_FILE" ]] || nf=" --notes-file $NOTES_FILE"
  cat >&2 <<EOF

$1. The release commit "Release $TAG" is in place; nothing is lost.
To finish, from this checkout of main:
EOF
  if [[ "${PUSHED:-0}" -eq 0 ]]; then
    echo "  git push origin main" >&2
  fi
  cat >&2 <<EOF
  scripts/release-mac.sh --publish$nf               # build, notarize and publish again
  scripts/release-mac.sh --publish --skip-build$nf  # or reuse the .app already built (and notarized, if that passed)
  scripts/deploy.sh verify $NEW                      # then check the release
EOF
}

bold "Commit and push"
if [[ -n "$(git status --porcelain -- "${CHANGED[@]}")" ]]; then
  git add -- "${CHANGED[@]}"
  git commit -q -m "Release $TAG"
  ok "committed: $(git log -1 --format='%h %s')"
else
  ok "nothing to commit (releasing $NEW as is)"
fi
COMMITTED=1
PUSHED=0
if git push -q origin main; then
  PUSHED=1
  ok "pushed main to origin"
else
  resume_help "git push failed"
  exit 1
fi

bold "Build, notarize and publish (scripts/release-mac.sh --publish)"
if ! scripts/release-mac.sh --publish --notes-file "$NOTES"; then
  resume_help "release-mac.sh --publish failed"
  exit 1
fi
git fetch -q --tags origin

echo
verify_release "$NEW" || { echo "the release exists but a check failed; re-check with: scripts/deploy.sh verify $NEW" >&2; exit 1; }

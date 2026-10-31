#!/usr/bin/env bash
# Build, sign, notarize and (optionally) publish the macOS release of Manga Studio.
#
#   scripts/release-mac.sh              build + sign + notarize + staple (no tag, no upload)
#   scripts/release-mac.sh --dry-run    checks + signed build + DMG, skips notarization and upload
#   scripts/release-mac.sh --publish    the above, then create the GitHub release vX.Y.Z (and its tag) with the assets
#
# Options:
#   --notes-file FILE   release notes (default: the "## [X.Y.Z]" section of CHANGELOG.md)
#   --ci                CI mode (used by .github/workflows/release.yml): skips the local git checks,
#                       expects the tag to exist already and notarizes with API-key or Apple ID env vars
#   --skip-build        reuse the .app already in the target dir (for re-running notarization)
#
# Environment:
#   SIGNING_IDENTITY    codesign identity (default: the "Developer ID Application ... (38QXSRV6AP)" in the keychain)
#   NOTARY_PROFILE      notarytool keychain profile (default: manga-studio-notary)
#   In --ci mode, notarization reads APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH,
#   or APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID.
#
# Why the DMG is made here and not by Tauri: Tauri's DMG wraps the .app before it is notarized and
# stapled. We build the .app, notarize and staple it, and only then put it in a DMG, which is signed,
# notarized and stapled in turn. Both carry a ticket, so Gatekeeper passes offline too.
#
# Secrets are never printed: notarytool reads them from the keychain profile or the environment.

set -euo pipefail

TEAM_ID="38QXSRV6AP"
TARGET="aarch64-apple-darwin"
STABLE_DMG="Manga-Studio-macOS-arm64.dmg"
NOTARY_PROFILE="${NOTARY_PROFILE:-manga-studio-notary}"

DRY_RUN=0
PUBLISH=0
CI_MODE=0
SKIP_BUILD=0
NOTES_FILE=""

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --publish) PUBLISH=1 ;;
    --ci) CI_MODE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --notes-file) NOTES_FILE="${2:?--notes-file needs a path}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ $DRY_RUN -eq 1 && $PUBLISH -eq 1 ]]; then
  echo "--dry-run and --publish can't be combined" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  ok    %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*"; }
FAILS=()
fail() { printf '  FAIL  %s\n' "$*"; FAILS+=("$1"); }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
bold "Checks"

for cmd in node pnpm cargo xcrun codesign hdiutil ditto shasum security spctl; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing command: $cmd"
done
if [[ $CI_MODE -eq 0 ]]; then
  command -v memgate >/dev/null 2>&1 || fail "missing memgate (heavy builds go through it; see ~/.claude/CLAUDE.md)"
fi

[[ "$(uname -m)" == "arm64" ]] || fail "build on Apple Silicon (this is $(uname -m))"

# scripts/version.sh is the one reader/writer of the version (tauri.conf.json, package.json files,
# Cargo.toml/.lock, pyproject.toml/uv.lock, the website's DOWNLOAD.version).
VERSION="$(scripts/version.sh get)"
TAG="v$VERSION"
if VCHECK="$(scripts/version.sh check 2>&1)"; then
  ok "version $VERSION in every file (scripts/version.sh check)"
else
  printf '%s\n' "$VCHECK" | sed 's/^/      /'
  fail "versions differ (fix with: scripts/version.sh set $VERSION)"
fi

# In a dry run the git checks only warn, so the build can be tried from a branch.
gitcheck() { if [[ $DRY_RUN -eq 1 ]]; then warn "$1 (ignored in --dry-run)"; else fail "$1"; fi; }

if [[ $CI_MODE -eq 1 ]]; then
  if [[ -n "${GITHUB_REF_NAME:-}" && "${GITHUB_REF_NAME}" != "$TAG" ]]; then
    fail "tag $GITHUB_REF_NAME doesn't match version $VERSION"
  else
    ok "CI tag $TAG"
  fi
else
  if [[ -n "$(git status --porcelain)" ]]; then gitcheck "git tree has uncommitted changes"; else ok "git tree clean"; fi
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$BRANCH" != "main" ]]; then gitcheck "on branch $BRANCH, not main"; else ok "on main"; fi
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    gitcheck "tag $TAG already exists locally (bump the version)"
  elif git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
    gitcheck "tag $TAG already exists on origin (bump the version)"
  else
    ok "tag $TAG is free"
  fi
  if [[ $PUBLISH -eq 1 ]]; then
    git fetch -q origin main 2>/dev/null || true
    if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main 2>/dev/null || echo none)" ]]; then
      fail "HEAD isn't origin/main (push main first)"
    fi
  fi
fi

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  ok "gh is logged in"
elif [[ $PUBLISH -eq 1 || $CI_MODE -eq 1 ]]; then
  fail "gh isn't logged in (run: gh auth login)"
else
  warn "gh isn't logged in (needed for --publish)"
fi

# Signing identity
if [[ -z "${SIGNING_IDENTITY:-}" ]]; then
  SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n "s/.*\"\(Developer ID Application: .*($TEAM_ID)\)\"/\1/p" | head -1)"
fi
if [[ -n "$SIGNING_IDENTITY" ]] && security find-identity -v -p codesigning | grep -qF "\"$SIGNING_IDENTITY\""; then
  ok "signing identity: $SIGNING_IDENTITY"
else
  fail "no 'Developer ID Application: ... ($TEAM_ID)' identity in the keychain"
fi

# Notarization credentials
NOTARY_AUTH=()
if [[ $CI_MODE -eq 1 ]]; then
  if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
    NOTARY_AUTH=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
    ok "notary: App Store Connect API key"
  elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    NOTARY_AUTH=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
    ok "notary: Apple ID"
  elif [[ $DRY_RUN -eq 0 ]]; then
    fail "no notarization credentials in the environment (see docs/RELEASING.md)"
  fi
else
  NOTARY_AUTH=(--keychain-profile "$NOTARY_PROFILE")
  if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    ok "notary profile: $NOTARY_PROFILE"
  else
    msg="notarytool keychain profile '$NOTARY_PROFILE' not found"
    if [[ $DRY_RUN -eq 1 ]]; then warn "$msg (not needed for --dry-run)"; else fail "$msg"; fi
    cat <<EOF

        One-time setup, either with an app-specific password (appleid.apple.com > Sign-In and Security):
          xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <your Apple ID email> --team-id $TEAM_ID
        or with an App Store Connect API key (Users and Access > Integrations > Team Keys, role Developer):
          xcrun notarytool store-credentials $NOTARY_PROFILE --key <path/AuthKey_XXXX.p8> --key-id <KEY ID> --issuer <ISSUER UUID>
        notarytool prompts for the password and stores it in the login keychain.

EOF
  fi
fi

# Release notes (needed only to publish)
if [[ $PUBLISH -eq 1 ]]; then
  NOTES_TMP="$(mktemp -t manga-studio-notes)"
  if [[ -n "$NOTES_FILE" ]]; then
    if [[ -s "$NOTES_FILE" ]]; then
      /bin/cp -f "$NOTES_FILE" "$NOTES_TMP"
      ok "release notes from $NOTES_FILE"
    else
      fail "notes file $NOTES_FILE is missing or empty"
    fi
  else
    scripts/changelog.sh section "$VERSION" >"$NOTES_TMP" 2>/dev/null || true
    if grep -q '[^[:space:]]' "$NOTES_TMP"; then ok "release notes from CHANGELOG.md [$VERSION]"; else fail "no '## [$VERSION]' section in CHANGELOG.md (or pass --notes-file)"; fi
  fi
fi

if [[ ${#FAILS[@]} -gt 0 ]]; then
  die "${#FAILS[@]} check(s) failed"
fi

# ---------------------------------------------------------------------------------------------
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/app/src-tauri/target}"
APP="$TARGET_DIR/$TARGET/release/bundle/macos/Manga Studio.app"
OUT="$ROOT/dist/release"
VERSIONED_DMG="Manga-Studio-$VERSION-macOS-arm64.dmg"

if [[ $SKIP_BUILD -eq 0 ]]; then
  bold "Build ($TARGET, signed)"
  rustup target list --installed 2>/dev/null | grep -qx "$TARGET" || rustup target add "$TARGET"
  (cd app && pnpm install --frozen-lockfile)
  /bin/rm -rf "$APP"
  # Tauri signs (APPLE_SIGNING_IDENTITY) with the hardened runtime. Its own notarization is turned
  # off by unsetting its credential variables: this script notarizes after the build instead.
  BUILD=(env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH
    -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD
    APPLE_SIGNING_IDENTITY="$SIGNING_IDENTITY"
    pnpm tauri build --target "$TARGET" --bundles app)
  if [[ $CI_MODE -eq 1 ]]; then
    (cd app && "${BUILD[@]}")
  else
    (cd app && memgate --profile release -- "${BUILD[@]}")
  fi
fi
[[ -d "$APP" ]] || die "no app at $APP"

# ---------------------------------------------------------------------------------------------
bold "Verify signature"
codesign --verify --deep --strict --verbose=2 "$APP"
SIGINFO="$(codesign -dvv "$APP" 2>&1)"
grep -q "Authority=Developer ID Application" <<<"$SIGINFO" || die "app isn't signed with a Developer ID Application identity"
grep -q "TeamIdentifier=$TEAM_ID" <<<"$SIGINFO" || die "app isn't signed by team $TEAM_ID"
grep -q "flags=.*runtime" <<<"$SIGINFO" || die "app isn't signed with the hardened runtime"
ok "Developer ID, team $TEAM_ID, hardened runtime"

# Every Mach-O inside the bundle must be signed by us, or notarization rejects it
# (matters once the Python backend, and anything compiled with it, ships in Resources).
UNSIGNED=()
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q 'Mach-O'; then
    codesign --verify --strict "$f" >/dev/null 2>&1 || UNSIGNED+=("${f#"$APP"/}")
  fi
done < <(find "$APP/Contents" -type f -print0)
if [[ ${#UNSIGNED[@]} -gt 0 ]]; then
  printf '  unsigned Mach-O: %s\n' "${UNSIGNED[@]}"
  die "${#UNSIGNED[@]} unsigned Mach-O file(s) in the bundle; sign them during the build"
fi
ok "every Mach-O in the bundle is signed"

# ---------------------------------------------------------------------------------------------
notarize() { # notarize <file>: submit, wait, print the log on failure
  local file="$1" json id status
  json="$(xcrun notarytool submit "$file" "${NOTARY_AUTH[@]}" --wait --output-format json)" || {
    echo "$json"
    die "notarytool submit failed for $(basename "$file")"
  }
  id="$(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.id||"")' "$json")"
  status="$(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.status||"")' "$json")"
  if [[ "$status" != "Accepted" ]]; then
    echo "notarization status: $status (submission $id)"
    [[ -n "$id" ]] && xcrun notarytool log "$id" "${NOTARY_AUTH[@]}" || true
    die "notarization of $(basename "$file") was not accepted"
  fi
  ok "notarized $(basename "$file") (submission $id)"
}

/bin/rm -rf "$OUT"
mkdir -p "$OUT"
WORK="$(mktemp -d -t manga-studio-release)"
trap '/bin/rm -rf "$WORK"' EXIT

if [[ $DRY_RUN -eq 0 ]] && xcrun stapler validate -q "$APP" >/dev/null 2>&1; then
  ok "app already notarized and stapled"
elif [[ $DRY_RUN -eq 0 ]]; then
  bold "Notarize the app"
  ditto -c -k --keepParent "$APP" "$WORK/app.zip"
  notarize "$WORK/app.zip"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl -a -vv -t exec "$APP"
else
  warn "dry run: app not notarized"
fi

# ---------------------------------------------------------------------------------------------
bold "DMG"
STAGE="$WORK/dmg"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Manga Studio.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Manga Studio" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$OUT/$VERSIONED_DMG"
codesign --sign "$SIGNING_IDENTITY" --timestamp "$OUT/$VERSIONED_DMG"
codesign --verify --strict --verbose=2 "$OUT/$VERSIONED_DMG"
ok "signed $VERSIONED_DMG"

if [[ $DRY_RUN -eq 0 ]]; then
  bold "Notarize the DMG"
  notarize "$OUT/$VERSIONED_DMG"
  xcrun stapler staple "$OUT/$VERSIONED_DMG"
  xcrun stapler validate "$OUT/$VERSIONED_DMG"
  spctl -a -vv -t open --context context:primary-signature "$OUT/$VERSIONED_DMG"
else
  warn "dry run: DMG not notarized (spctl would reject it until it is)"
fi

/bin/cp -f "$OUT/$VERSIONED_DMG" "$OUT/$STABLE_DMG"
(cd "$OUT" && shasum -a 256 "$STABLE_DMG" "$VERSIONED_DMG" >SHA256SUMS.txt)
ok "assets in dist/release/:"
# shellcheck disable=SC2012 # a listing for people, of names this script chose
(cd "$OUT" && ls -lh | sed '1d;s/^/        /' && sed 's/^/        /' SHA256SUMS.txt)

ASSETS=("$OUT/$STABLE_DMG" "$OUT/$VERSIONED_DMG" "$OUT/SHA256SUMS.txt")

# ---------------------------------------------------------------------------------------------
if [[ $CI_MODE -eq 1 && -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "assets_dir=$OUT" >>"${GITHUB_OUTPUT:-/dev/null}"
fi

if [[ $PUBLISH -eq 1 ]]; then
  bold "Publish $TAG"
  if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" "${ASSETS[@]}" --clobber
  elif [[ $CI_MODE -eq 1 ]]; then
    gh release create "$TAG" "${ASSETS[@]}" --verify-tag --title "Manga Studio $VERSION" --notes-file "$NOTES_TMP"
  else
    # gh creates the tag on origin at HEAD (== origin/main, checked above) only when it publishes
    # the release, after the assets are uploaded. So the tag-triggered workflow finds the DMG
    # already there and skips instead of building a second copy.
    gh release create "$TAG" "${ASSETS[@]}" --target "$(git rev-parse HEAD)" --title "Manga Studio $VERSION" --notes-file "$NOTES_TMP"
    git fetch -q origin "refs/tags/$TAG:refs/tags/$TAG"
  fi
  ok "released: $(gh release view "$TAG" --json url --jq .url)"
elif [[ $DRY_RUN -eq 1 ]]; then
  bold "Dry run done: signed, not notarized, nothing tagged or uploaded."
else
  bold "Built and notarized. Publish with: scripts/release-mac.sh --publish --skip-build"
fi

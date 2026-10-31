# Releasing Manga Studio for macOS

Each release is a signed and notarized DMG for Apple Silicon, attached to a GitHub release. The
website's Download button links to
`https://github.com/Himasnhu-AT/manga-studio/releases/latest/download/Manga-Studio-macOS-arm64.dmg`,
so a new release changes the download without a website deploy.

Every release has three assets:

| Asset | What |
|---|---|
| `Manga-Studio-macOS-arm64.dmg` | stable name, the one the website links to |
| `Manga-Studio-X.Y.Z-macOS-arm64.dmg` | the same file, with the version in its name |
| `SHA256SUMS.txt` | SHA-256 of both |

The `.app` and the DMG are both notarized and stapled, so Gatekeeper accepts them offline too.

## One-time setup (this Mac)

The `Developer ID Application: Himanshu . (38QXSRV6AP)` certificate is already in the login
keychain. Notarization needs credentials stored once in a notarytool keychain profile named
`manga-studio-notary`. Use either an app-specific password or an API key.

**App-specific password.** Create one at appleid.apple.com > Sign-In and Security > App-Specific
Passwords, then run:

```bash
xcrun notarytool store-credentials manga-studio-notary --apple-id <your Apple ID email> --team-id 38QXSRV6AP
```

**App Store Connect API key.** Create one at App Store Connect > Users and Access > Integrations >
Team Keys with the Developer role, download `AuthKey_<KEYID>.p8` (it can be downloaded only once),
then run:

```bash
xcrun notarytool store-credentials manga-studio-notary --key ~/path/AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER UUID>
```

notarytool asks for the secret and keeps it in the login keychain; it never goes into the repo.
Check it with `xcrun notarytool history --keychain-profile manga-studio-notary`. To use a profile
with another name, set `NOTARY_PROFILE`.

## Cut a release: `scripts/deploy.sh` (the normal path)

From a clean, up-to-date checkout of `main`:

```bash
scripts/deploy.sh patch --dry-run   # rehearse: checks, bump, notes, signed build; then puts every file back
scripts/deploy.sh patch             # 0.2.0 -> 0.2.1 (or minor, major, or an exact X.Y.Z)
```

It runs these steps and stops at the first failure:

1. **Preflight.** You are on `main`, the tree is clean, and `main` isn't behind `origin/main`. The
   tag and the GitHub release are free, `gh` is logged in, the Developer ID identity is in the
   keychain and the `manga-studio-notary` profile works. Then `uv run pytest -q tests/`, the app
   typecheck and build, and the website build.
2. **Version.** `scripts/version.sh set X.Y.Z` writes the version everywhere it lives:
   `tauri.conf.json`, `app/package.json`, `Cargo.toml` and its `Cargo.lock` entry, `pyproject.toml`
   and its `uv.lock` entry, `website/package.json` and `DOWNLOAD.version` in
   `website/components/site.ts`.
3. **Changelog.** The notes under `## [Unreleased]` become `## [X.Y.Z] - today`, a fresh empty
   `[Unreleased]` goes on top, and the compare links at the bottom are updated. If `[Unreleased]` is
   empty, the section is drafted from commit subjects since the last release (Added / Changed /
   Fixed) and opens in `$EDITOR`. Before going on it shows the notes and asks; `--yes` skips the
   editor and the question.
4. **Publish.** It commits "Release vX.Y.Z", pushes `main` and runs
   `scripts/release-mac.sh --publish` with that section as the release notes, then fetches the tag.
5. **Verify.** The release has `Manga-Studio-macOS-arm64.dmg`, the versioned DMG and
   `SHA256SUMS.txt`, and `/releases/latest/download/Manga-Studio-macOS-arm64.dmg` redirects to it.
   It prints the release URL. Re-run this check any time with `scripts/deploy.sh verify X.Y.Z`.

Options: `--yes` (no review), `--dry-run`, `--notes-file F` (release notes from F instead of the
CHANGELOG section). Passing the current version releases it as is, without a bump, when the
CHANGELOG already has its section and there is no tag yet. That is how the first release, 0.2.0,
goes out: `scripts/deploy.sh 0.2.0`.

`--dry-run` softens the git, `gh` and notary checks to warnings, so it also works from a branch
before the notary profile exists. It shows the version diff and the notes, runs
`scripts/release-mac.sh --dry-run`, and then restores every file it changed. Nothing is committed,
pushed, tagged or uploaded.

**If it fails after the release commit** (notarization rejected, upload interrupted), it prints the
commands to finish. The release commit is already on `main`, so you don't run `deploy.sh` again:

```bash
scripts/release-mac.sh --publish --skip-build   # reuse the .app already built (and notarized)
scripts/release-mac.sh --publish                # or build again
scripts/deploy.sh verify X.Y.Z
```

### Between releases: keep the changelog

Add a line to `[Unreleased]` whenever you merge something users will notice:

```bash
scripts/changelog.sh add "Export sheet remembers the last paper size" --type added
scripts/changelog.sh add "Bubbles no longer jump when a panel is cropped" --type fixed
scripts/changelog.sh unreleased     # what the next release will say
```

Types are `added`, `changed` (the default), `fixed`, `removed`, `deprecated` and `security`.
`scripts/changelog.sh draft` previews what would be drafted from commits.

## `scripts/release-mac.sh` (the lower-level step)

`deploy.sh` calls this script to build, sign, notarize and publish. Run it by hand to rebuild or to
finish an interrupted release. It expects the version and the CHANGELOG section to be committed
already (`scripts/version.sh check` must pass):

```bash
scripts/release-mac.sh --dry-run    # checks + signed build + signed DMG; no notarization, no upload
scripts/release-mac.sh              # build, sign, notarize and staple; assets in dist/release/
scripts/release-mac.sh --publish    # the same, then create GitHub release vX.Y.Z with the assets
```

To publish a build you already notarized, run `scripts/release-mac.sh --publish --skip-build`. It
reuses the stapled `.app` and makes, notarizes and staples a new DMG. Pass
`--notes-file notes.md` to use other release notes than the CHANGELOG section.

The script stops before building if any of these fails:

- the version is the same in every file (`scripts/version.sh check`)
- the git tree is clean, you are on `main`, and `vX.Y.Z` isn't a tag yet, locally or on origin
- `gh` is logged in (needed for `--publish`)
- the Developer ID identity is in the keychain
- the `manga-studio-notary` profile works (needed unless `--dry-run`)
- for `--publish`: `HEAD` is `origin/main`, and the CHANGELOG has a section for the version

In `--dry-run` the git checks only warn, so you can try a build from a branch.

The heavy build runs through `memgate --profile release`. Tauri builds and signs the `.app` with the
hardened runtime. The script then:

1. checks the signature (Developer ID, team 38QXSRV6AP, hardened runtime) and that every Mach-O
   file in the bundle is signed
2. notarizes and staples the `.app`
3. puts the stapled app in a DMG with an Applications link, then signs, notarizes and staples the DMG
4. verifies both with `stapler validate` and `spctl`

Tauri's own DMG isn't used because it packs the app before notarization, so the app inside it
would carry no ticket.

`--publish` runs `gh release create vX.Y.Z --target <HEAD>`. gh creates the tag on GitHub only when
the release is published, after the assets have uploaded. So when the tag triggers the release
workflow, the DMG is already there and the workflow skips.

### Checking a download

```bash
xcrun stapler validate Manga-Studio-macOS-arm64.dmg
spctl -a -vv -t open --context context:primary-signature Manga-Studio-macOS-arm64.dmg   # "accepted, source=Notarized Developer ID"
shasum -a 256 -c SHA256SUMS.txt
```

After mounting the DMG, check the app with `spctl -a -vv -t exec "/Volumes/Manga Studio/Manga Studio.app"`.

## CI (`.github/workflows/release.yml`)

When a `v*` tag is pushed, or the workflow is started by hand with a tag, it runs
`scripts/release-mac.sh --ci --publish` on a `macos-14` (Apple Silicon) runner. It creates the
release, or uploads to an existing one. It skips with a notice, and doesn't fail, when
`MACOS_CERTIFICATE` isn't set or the release already has the DMG. Until the secrets are set,
releases come from the local script.

Repository secrets (Settings > Secrets and variables > Actions):

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE` | the Developer ID Application certificate and its private key, as a base64 `.p12` |
| `MACOS_CERTIFICATE_PASSWORD` | the password you gave the `.p12` when exporting it |
| `KEYCHAIN_PASSWORD` | any random string; it locks the temporary keychain on the runner |
| `APPLE_API_KEY_ID` | App Store Connect API key ID (notarization, preferred) |
| `APPLE_API_ISSUER` | App Store Connect issuer UUID |
| `APPLE_API_KEY_P8` | the full text of `AuthKey_<KEYID>.p8` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | the Apple ID route instead of the API key: email, app-specific password, `38QXSRV6AP` |

To export the certificate, open Keychain Access > login > My Certificates, right-click "Developer ID
Application: Himanshu . (38QXSRV6AP)", choose Export, and save it as `.p12` with a password. Then run:

```bash
gh secret set MACOS_CERTIFICATE --body "$(base64 -i DeveloperID.p12)"
gh secret set MACOS_CERTIFICATE_PASSWORD          # prompts
gh secret set KEYCHAIN_PASSWORD --body "$(openssl rand -hex 24)"
gh secret set APPLE_API_KEY_ID                    # prompts
gh secret set APPLE_API_ISSUER                    # prompts
gh secret set APPLE_API_KEY_P8 < AuthKey_<KEYID>.p8
rm DeveloperID.p12
```

The workflow pins every action to a commit SHA, with the release tag in a comment beside it.

## Website (Vercel)

The site in `website/` is a static Next.js export (`output: "export"`). Vercel's Next.js preset
builds it as is, so there is no `vercel.json`.

1. In Vercel, Add New > Project and import `Himasnhu-AT/manga-studio`.
2. Set **Root Directory** to `website`. Keep the Framework Preset as Next.js. Vercel finds
   `pnpm-lock.yaml` and installs with pnpm. The build command is `next build`.
3. Optional environment variables: `NEXT_PUBLIC_SITE_URL` (it defaults to
   `https://mangastudio.marlstudio.com`, which is used for absolute OG and Twitter image URLs) and
   `NEXT_PUBLIC_REPO_URL`.
4. Deploy. Then go to Settings > Domains and add `mangastudio.marlstudio.com`.
5. At the DNS host for `marlstudio.com`, add a CNAME record from `mangastudio` to
   `cname.vercel-dns.com`. Vercel issues the certificate once the record resolves.
6. Optional: under Settings > Git > Ignored Build Step, run
   `git diff --quiet HEAD^ HEAD -- .` so only commits that touch `website/` deploy.

The Download button needs no deploy for a new release, because `/releases/latest/download/` always
points to the newest release. The button's caption shows `DOWNLOAD.version` from
`website/components/site.ts`; `deploy.sh` bumps it with the rest, and the push to `main` redeploys
the site.

## Notes

- **Minimum macOS.** MLX 0.32 ships wheels only for macOS 14 and later, so the app needs macOS 14.
  `tauri.conf.json` should set `bundle.macOS.minimumSystemVersion` to `"14.0"`. Tauri's default is
  10.13, which would let the app open on Macs where the backend can't run.
- **Entitlements.** None are needed. Tauri signs with the hardened runtime by default, and WKWebView
  needs no JIT entitlement. The app isn't sandboxed, so spawning `uv` and Python from outside the
  bundle is allowed.
- **Bundled backend.** If Python, or any compiled extension (`.so`, `.dylib`), ships inside
  `Contents/Resources`, every Mach-O file there has to be signed with the Developer ID and the
  hardened runtime, or notarization rejects it. The script lists unsigned Mach-O files and stops
  before notarizing. Python source files and data need no signing.

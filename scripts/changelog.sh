#!/usr/bin/env bash
# Keep CHANGELOG.md (Keep a Changelog format) between and at releases.
#
#   scripts/changelog.sh add "<line>" [--type added|changed|fixed|removed|deprecated|security]
#        add a bullet to ## [Unreleased] (default type: changed)
#   scripts/changelog.sh unreleased        print the ## [Unreleased] notes (empty if none)
#   scripts/changelog.sh draft [--since REF]
#        print notes drafted from commit subjects since REF (default: the last v* tag, or the
#        last commit that changed the version in tauri.conf.json); grouped Added/Changed/Fixed
#   scripts/changelog.sh release X.Y.Z [--date YYYY-MM-DD] [--since REF]
#        move the Unreleased notes (or, if there are none, a draft from commits) into
#        "## [X.Y.Z] - date", start a fresh empty Unreleased, update the compare links.
#        Prints "moved" or "drafted".
#   scripts/changelog.sh section X.Y.Z     print the notes of one release (for release notes)
#   scripts/changelog.sh links             rewrite the compare links at the bottom
#
# CHANGELOG (default CHANGELOG.md in the repo root) and REPO_URL (default: from the origin
# remote) can be set in the environment.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CHANGELOG="${CHANGELOG:-CHANGELOG.md}"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }
die() { printf 'changelog.sh: %s\n' "$*" >&2; exit 1; }

[[ -f "$CHANGELOG" ]] || die "no $CHANGELOG"

repo_url() {
  if [[ -n "${REPO_URL:-}" ]]; then echo "${REPO_URL%/}"; return; fi
  local u
  u="$(git remote get-url origin 2>/dev/null || true)"
  u="${u%.git}"
  u="${u/#git@github.com:/https://github.com/}"
  echo "${u:-https://github.com/Himasnhu-AT/manga-studio}"
}

# Split the file into parts. A "## " heading starts a section; lines like "[x]: url" at the end
# are link definitions. part=head|unreleased|rest|links prints that part.
split_part() {
  awk -v part="$1" '
    /^## / {
      sec = ($0 ~ /^## \[Unreleased\]/) ? "unreleased" : "rest"
      if (sec == "unreleased") next
    }
    /^\[[^]]+\]: / { if (part == "links") print; next }
    { s = sec == "" ? "head" : sec; if (s == part) print }
  ' "$CHANGELOG"
}

trim_blank() { # drop leading and trailing blank lines
  awk '{ a[NR] = $0 } END {
    s = 1; while (s <= NR && a[s] ~ /^[[:space:]]*$/) s++
    e = NR; while (e >= s && a[e] ~ /^[[:space:]]*$/) e--
    for (i = s; i <= e; i++) print a[i]
  }'
}

has_text() { grep -q '[^[:space:]]'; }

# Rebuild the compare links from the version headings, keeping any other link definitions.
links_for() { # links_for <file>
  local url
  url="$(repo_url)"
  awk -v url="$url" '
    /^## \[[0-9]+\.[0-9]+\.[0-9]+\]/ { v = $2; gsub(/[][]/, "", v); vs[n++] = v }
    /^\[[^]]+\]: / {
      label = $1; sub(/^\[/, "", label); sub(/\]:$/, "", label)
      if (label != "Unreleased" && label !~ /^[0-9]+\.[0-9]+\.[0-9]+$/) other[m++] = $0
    }
    END {
      if (n > 0) print "[Unreleased]: " url "/compare/v" vs[0] "...HEAD"
      for (i = 0; i < n; i++) {
        if (i + 1 < n) print "[" vs[i] "]: " url "/compare/v" vs[i + 1] "...v" vs[i]
        else print "[" vs[i] "]: " url "/releases/tag/v" vs[i]
      }
      for (j = 0; j < m; j++) print other[j]
    }
  ' "$1"
}

# Write head + [Unreleased] body + "## [X]" sections, then the links. Reads the body from $1.
assemble() { # assemble <unreleased-body-file> <extra-section-file-or-empty>
  local body="$1" extra="${2:-}" tmp out
  tmp="$(mktemp -t changelog)"
  {
    split_part head | trim_blank
    echo
    echo "## [Unreleased]"
    if has_text <"$body"; then echo; trim_blank <"$body"; fi
    echo
    if [[ -n "$extra" ]]; then trim_blank <"$extra"; echo; fi
    split_part rest | trim_blank
  } >"$tmp"
  out="$(mktemp "${CHANGELOG}.XXXXXX")"
  { cat "$tmp"; echo; links_for "$tmp"; } >"$out"
  /bin/rm -f "$tmp"
  chmod 644 "$out"
  mv -f "$out" "$CHANGELOG"
}

# Insert "- line" under "### Type" in a notes body (stdin), creating the group in
# Keep a Changelog order if needed.
add_to_body() { # add_to_body <Type> ; line in env CL_LINE
  awk -v type="$1" '
    BEGIN { split("Added Changed Deprecated Removed Fixed Security", order, " ") }
    /^### / { cur = substr($0, 5); if (!(cur in seen)) { seen[cur] = 1; groups[ng++] = cur }; next }
    {
      if (cur == "") { pre[np++] = $0; next }
      if ($0 ~ /^[[:space:]]*$/) next
      items[cur] = items[cur] $0 "\n"
    }
    END {
      if (!(type in seen)) { seen[type] = 1; groups[ng++] = type }
      items[type] = items[type] "- " ENVIRON["CL_LINE"] "\n"
      # free text above the first group, without its leading and trailing blank lines
      s = 0; while (s < np && pre[s] !~ /[^[:space:]]/) s++
      e = np - 1; while (e >= s && pre[e] !~ /[^[:space:]]/) e--
      for (i = s; i <= e; i++) print pre[i]
      first = (e < s)
      for (k = 1; k <= 6; k++) emit(order[k])
      for (g = 0; g < ng; g++) emit(groups[g])
    }
    function emit(t) {
      if (!(t in seen) || (t in done) || items[t] == "") return
      done[t] = 1
      if (!first) print ""
      first = 0
      print "### " t
      printf "%s", items[t]
    }
  '
}

latest_version() { # the newest "## [X.Y.Z]" in the changelog
  sed -n 's/^## \[\([0-9]*\.[0-9]*\.[0-9]*\)\].*/\1/p' "$CHANGELOG" | head -1
}

since_ref() { # since_ref [REF]: the commit to draft from (empty = whole history)
  if [[ -n "${1:-}" ]]; then echo "$1"; return; fi
  local v ref
  v="$(latest_version)"
  # The tag of the newest release in the changelog, else the newest v* tag, else (nothing
  # tagged yet) the commit that added the newest version's heading to the changelog.
  if [[ -n "$v" ]] && git rev-parse -q --verify "refs/tags/v$v" >/dev/null; then echo "v$v"; return; fi
  if ref="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null)"; then echo "$ref"; return; fi
  if [[ -n "$v" ]]; then
    git log -1 --format=%H -S"## [$v]" -- CHANGELOG.md 2>/dev/null || true
  fi
}

cmd_draft() {
  local since="" ref range
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since) since="${2:?--since needs a ref}"; shift ;;
      *) die "draft: unknown option $1" ;;
    esac
    shift
  done
  ref="$(since_ref "$since")"
  if [[ -n "$ref" ]]; then range="$ref..HEAD"; else range="HEAD"; fi
  git log --no-merges --reverse --format=%s "$range" | awk '
    /^Merge / || /^Release v[0-9]/ || /^Co-Authored-By/ || /^[[:space:]]*$/ { next }
    {
      s = $0
      # "fix(ui): crash on ..." -> "Crash on ..."; other subjects keep their case (file names)
      if (sub(/^(feat|fix|chore|docs|refactor|perf|test|build|ci|style)(\([^)]*\))?!?: */, "", s))
        s = toupper(substr(s, 1, 1)) substr(s, 2)
      l = tolower($0)
      if (l ~ /(^|[^a-z])(fix|fixes|fixed|bug|bugs|crash|crashes|broken|regression|typo)([^a-z]|$)/) t = "Fixed"
      else if (l ~ /^(add|adds|added|new|introduce|introduces|support|implement|create|feat)([^a-z]|$)/) t = "Added"
      else t = "Changed"
      items[t] = items[t] "- " s "\n"
    }
    END {
      n = split("Added Changed Fixed", order, " ")
      first = 1
      for (k = 1; k <= n; k++) {
        t = order[k]
        if (items[t] == "") continue
        if (!first) print ""
        first = 0
        print "### " t
        printf "%s", items[t]
      }
    }
  '
}

cmd_add() {
  local line="" type="changed" Type body
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --type) type="${2:?--type needs a value}"; shift ;;
      --type=*) type="${1#--type=}" ;;
      --) shift; line="$*"; break ;;
      --*) die "add: unknown option $1" ;;
      *) [[ -z "$line" ]] || die "add: one line at a time (quote it)"; line="$1" ;;
    esac
    shift
  done
  [[ -n "${line//[[:space:]]/}" ]] || die 'add needs a line: scripts/changelog.sh add "Fix ..." --type fixed'
  line="${line#- }"
  case "$type" in
    added|changed|fixed|removed|deprecated|security) ;;
    *) die "--type must be added, changed, fixed, removed, deprecated or security" ;;
  esac
  Type="$(tr '[:lower:]' '[:upper:]' <<<"${type:0:1}")${type:1}"
  body="$(mktemp -t changelog)"
  split_part unreleased | CL_LINE="$line" add_to_body "$Type" >"$body"
  assemble "$body"
  /bin/rm -f "$body"
  echo "added to [Unreleased] / $Type: - $line"
}

cmd_section() {
  local v="${1:?section needs X.Y.Z}"
  awk -v v="$v" '
    /^\[[^]]+\]: / { next }
    /^## / { if (on) exit; if (index($0, "## [" v "]") == 1) { on = 1; next } }
    on { print }
  ' "$CHANGELOG" | trim_blank
}

cmd_release() {
  local v="" date since="" body section how
  date="$(date +%Y-%m-%d)"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --date) date="${2:?--date needs YYYY-MM-DD}"; shift ;;
      --since) since="${2:?--since needs a ref}"; shift ;;
      -*) die "release: unknown option $1" ;;
      *) v="$1" ;;
    esac
    shift
  done
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "release needs X.Y.Z"
  [[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "--date must be YYYY-MM-DD"
  grep -q "^## \[$v\]" "$CHANGELOG" && die "$CHANGELOG already has a section for $v"
  body="$(mktemp -t changelog)"
  split_part unreleased | trim_blank >"$body"
  if has_text <"$body"; then
    how=moved
  else
    if [[ -n "$since" ]]; then cmd_draft --since "$since" >"$body"; else cmd_draft >"$body"; fi
    has_text <"$body" || { /bin/rm -f "$body"; die "no Unreleased notes and no commits to draft from"; }
    how=drafted
  fi
  section="$(mktemp -t changelog)"
  { echo "## [$v] - $date"; echo; cat "$body"; } >"$section"
  : >"$body"
  assemble "$body" "$section"
  /bin/rm -f "$body" "$section"
  echo "$how"
}

cmd_links() {
  local body
  body="$(mktemp -t changelog)"
  split_part unreleased >"$body"
  assemble "$body"
  /bin/rm -f "$body"
}

case "${1:-}" in
  add) shift; cmd_add "$@" ;;
  unreleased) split_part unreleased | trim_blank ;;
  draft) shift; cmd_draft "$@" ;;
  release) shift; cmd_release "$@" ;;
  section) shift; cmd_section "$@" ;;
  links) cmd_links ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac

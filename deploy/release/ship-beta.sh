#!/usr/bin/env bash
# deploy/release/ship-beta.sh - BETA FIRST, THEN PROMOTE (owner, 2026-11-01): finished work goes to
# beta.valuedesk.so before everyone gets it.
#
#   bash deploy/release/ship-beta.sh beta [--yes] [--dry-run]     HEAD to the beta: tag, test gate, the beta API, the beta site
#   bash deploy/release/ship-beta.sh promote <tag> [--yes] [...]  that same tag to everyone: ship.sh, run from the tag
#
# BETA (HEAD, or the tag it has):
#   1. the tag: the next vX.Y.Z (as ship.sh), pushed with this branch - main does not move;
#   2. the test gate (test-gate.sh): GitHub's CI for the tag - no beta without it;
#   3. the server tarball to server 1 (scp -l 8000), its operations scripts (deploy/server/bin) synced, then
#      `release.sh <tag> --beta`: /opt/valuescan/beta-current -> the tag and the beta API
#      (valuescan-api-beta.service, port 8798) restarted. Nothing else on either server is touched: the
#      site's API, the indexer and the copy executor keep running their releases;
#   4. the git branch `beta` moved to the tag: Vercel builds it for beta.valuedesk.so (deploy/vercel/build.sh:
#      beta.settings, the function marked VALUESCAN_CHANNEL=beta); it waits for that deployment and the site.
# No maintenance notice and no Telegram message: only the beta testers see it.
#
# PROMOTE <tag> (normally the tag the beta runs - it says so when not): a git worktree at the tag (in
# deploy/.out, removed after), and deploy/release/ship.sh run from it with --tag=<tag> and the other
# arguments given (--yes, --executor-ok, parts ...). So everyone gets exactly what the testers had, with
# every guard of ship.sh: the parts that changed since what runs, the executor's guards, the notice,
# Telegram, main moved last. Commits made after the tag wait for the next beta.
#
# The indexer and the copy executor have no beta: a tag whose indexer or executor changed runs its new API
# on beta against the indexer and executor that run now; they get the change on promote.
#
# Hosts and key as ship.sh (VS_SERVER1, VS_SSH_KEY); a GitHub token as ship.sh.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
. "$(dirname "${BASH_SOURCE[0]}")/test-gate.sh"

S1="${VS_SERVER1:-almalinux@161.97.154.121}"
KEY="${VS_SSH_KEY:-$HOME/.ssh/valuescan-contabo}"
BETA_SITE="${VS_BETA_SITE:-https://beta.valuedesk.so}"
INBOX=/var/cache/valuescan/inbox
SSH=(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o LogLevel=ERROR)
# The laptop's upload cap (~/.claude/CLAUDE.md: 10 Mbit/s up, one big transfer at a time).
SCP=(scp -q -l 8000 -i "$KEY" -o BatchMode=yes -o ConnectTimeout=20 -o LogLevel=ERROR)
G=(git -c windows.appendAtomically=false)
say() { printf '\n== %s\n' "$*" >&2; }
remote() { local host="$1"; shift; "${SSH[@]}" "$host" "$@"; }

MODE="${1:-}"; shift || true
case "$MODE" in
  beta|promote) ;;
  -h|--help|'') sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "first argument: beta or promote <tag>" ;;
esac

if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME"/AppData/Local/ddx-tools/node-v*-win-x64; do [ -x "$d/node.exe" ] && PATH="$d:$PATH"; done
fi
command -v node >/dev/null 2>&1 || die "no node on PATH"

# The tag the beta runs now (server 1's release.sh --status, line "beta:").
beta_live() { remote "$S1" 'sudo /opt/valuescan/bin/release.sh --status' 2>/dev/null | sed -n 's/^beta: .*(beta-current \([^)]*\)).*/\1/p' | head -1; }

# --- promote --------------------------------------------------------------------------------------
if [ "$MODE" = promote ]; then
  TAG="${1:-}"; [ -n "$TAG" ] || die "promote needs the tag: ship-beta.sh promote vX.Y.Z"; shift
  valid_tag "$TAG" || die "not a usable tag: $TAG"
  "${G[@]}" fetch -q origin main --tags
  git rev-parse -q --verify "refs/tags/$TAG^{commit}" >/dev/null || die "no tag $TAG"
  live="$(beta_live || true)"
  if [ "$live" != "$TAG" ]; then note "!! the beta runs ${live:-nothing known}, not $TAG: promoting $TAG all the same"; fi
  "${G[@]}" merge-base --is-ancestor origin/main "$TAG" || die "$TAG does not contain origin/main: it cannot move main forward"
  WT="$OUT_DIR/promote-$TAG"
  rm -rf "$WT"; "${G[@]}" worktree prune
  mkdir -p "$OUT_DIR"
  "${G[@]}" worktree add -q --detach "$WT" "$TAG"
  trap '"${G[@]}" worktree remove --force "$WT" >/dev/null 2>&1 || true' EXIT
  say "promote $TAG: deploy/release/ship.sh from the tag"
  rc=0
  ( cd "$WT" && bash deploy/release/ship.sh --tag="$TAG" "$@" ) || rc=$?
  # ship.sh's line in ships.log was written in the worktree: kept with this checkout's.
  if [ -f "$WT/$OUT_DIR/ships.log" ]; then cat "$WT/$OUT_DIR/ships.log" >> "$OUT_DIR/ships.log"; fi
  exit "$rc"
fi

# --- beta -----------------------------------------------------------------------------------------
YES=0 DRY=0
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    *) die "beta takes --yes and --dry-run only" ;;
  esac
done
if [ -z "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]; then
  GITHUB_TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | sed -n 's/^password=//p' || true)"
  export GITHUB_TOKEN
fi
[ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ] || die "no GitHub token (GITHUB_TOKEN, or git's credential for github.com)"
REPO="$(git remote get-url origin | sed -E 's#^(https://([^@/]*@)?github\.com/|git@github\.com:)##; s#\.git$##')"
gh_api() { GH_PATH="$1" node --input-type=module -e '
  const r = await fetch(`https://api.github.com/repos/${process.env.GH_PATH}`, { headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN || process.env.GH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "valuedesk-ship" } }).catch(() => null);
  process.stdout.write(r && r.ok ? await r.text() : "null");'; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=null;try{v=JSON.parse(s||"null")}catch{};const f=new Function("v",`return (${process.argv[1]})`);const o=f(v);process.stdout.write(o==null?"":String(o))})' "$1"; }

say "what the beta runs"
"${G[@]}" fetch -q origin main --tags
HEAD_SHA="$(git rev-parse HEAD)"
BRANCH="$(git symbolic-ref --short -q HEAD || true)"
"${G[@]}" merge-base --is-ancestor origin/main HEAD || die "HEAD does not contain origin/main: bring this branch up to date with main first"
note "beta now: $(beta_live || echo '?')   site: main $(git rev-parse --short origin/main)"

TAG="$(git describe --exact-match --tags --match 'v[0-9]*' HEAD 2>/dev/null || true)"
NEW_TAG=0
if [ -z "$TAG" ]; then
  TAG="$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -1 | awk -F. '{printf "%s.%s.%d", $1, $2, $3 + 1}')"
  NEW_TAG=1
fi
valid_tag "$TAG" || die "not a usable tag: $TAG"
say "plan: $TAG ($(git rev-parse --short HEAD)$([ "$NEW_TAG" = 1 ] && echo ", new tag")) to the beta"
note "  server 1   release.sh $TAG --beta: the beta API only (port 8798); the site's API, indexer and executor untouched"
note "  Vercel     branch beta -> $TAG: $BETA_SITE"
note "  then       bash deploy/release/ship-beta.sh promote $TAG --yes   (everyone)"
dirty="$(git status --porcelain -- apps packages deploy/server package.json package-lock.json | grep -v '^?? deploy/\.out/' || true)"
[ -z "$dirty" ] || note "  not in $TAG (uncommitted):
$(printf '%s\n' "$dirty" | sed 's/^/    /')"
[ "$DRY" = 0 ] || { note "dry run: nothing done"; exit 0; }
if [ "$YES" != 1 ]; then
  [ -t 0 ] || die "no terminal to ask: add --yes once the plan above is agreed"
  read -r -p "Ship $TAG to the beta? [y/N] " a
  case "$a" in y|Y|yes) ;; *) die "not shipped" ;; esac
fi

# 1. the tag
if [ "$NEW_TAG" = 1 ]; then
  last="$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD 2>/dev/null || true)"
  "${G[@]}" tag -a "$TAG" -m "$TAG (beta): $(git log --format='%s' ${last:+"$last.."}HEAD | head -1 | cut -c1-180)" HEAD
fi
refs=("refs/tags/$TAG")
[ -z "$BRANCH" ] || [ "$BRANCH" = main ] || [ "$BRANCH" = beta ] || refs+=("HEAD:refs/heads/$BRANCH")
"${G[@]}" push -q origin "${refs[@]}"

# 2. the test gate
say "test gate"
for _ in $(seq 1 18); do
  [ "$(gh_api "$REPO/actions/runs?head_sha=$HEAD_SHA" | json 'v ? v.total_count : 0')" -gt 0 ] && break
  sleep 10
done
test_gate "$TAG"

# 3. server 1: the beta API
say "server 1: the beta API"
TARBALL="$(server_tarball "$TAG")"
b="$(basename "$TARBALL")"
note "uploading $b to $S1 (scp -l 8000)"
"${SCP[@]}" "$TARBALL" "$TARBALL.sha256" "$S1:/tmp/"
remote "$S1" "set -e; for f in $b $b.sha256; do sudo install -D -m 0640 /tmp/\$f $INBOX/\$f; rm -f /tmp/\$f; done; sudo bash -c 'cd $INBOX && sha256sum -c --quiet $b.sha256'"
# release.sh from the tarball first: the one installed may not know --beta yet.
remote "$S1" "sudo bash -s -- $INBOX/$b" <<'EOF'
set -euo pipefail
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
tar -xzf "$1" -C "$tmp" --strip-components=1 --no-same-owner --wildcards '*/deploy/server/bin/*'
for f in "$tmp"/deploy/server/bin/*; do
  case "$f" in *.test.mjs|*.test.sh) continue ;; esac
  d="/opt/valuescan/bin/$(basename "$f")"
  if [ -f "$d" ] && cmp -s "$f" "$d"; then continue; fi
  if [ -f "$d" ]; then cp -p "$d" "$d.prev"; fi
  install -m 0755 -o root -g root "$f" "$d.new" && mv -f "$d.new" "$d"
  echo "  bin: $(basename "$f")"
done
EOF
remote "$S1" "sudo /opt/valuescan/bin/release.sh $TAG --beta --from=$INBOX/$b && sudo rm -f $INBOX/$b $INBOX/$b.sha256"

# 4. the beta site
say "branch beta -> $TAG"
# A commit of its own on top of the tag (the same files): Vercel builds a commit it already built for
# another branch never again (v0.2.128, 2026-11-01: no beta deployment at all), and only a build of the
# branch `beta` is the beta site.
BETA_SHA="$(git -c user.name="$(git log -1 --format=%an "$HEAD_SHA")" -c user.email="$(git log -1 --format=%ae "$HEAD_SHA")" commit-tree "$HEAD_SHA^{tree}" -p "$HEAD_SHA" -m "beta: $TAG (deploy/release/ship-beta.sh)")"
"${G[@]}" push -q --force origin "$BETA_SHA:refs/heads/beta"
note "waiting for Vercel's deployment of ${BETA_SHA:0:7} (= $TAG) on branch beta"
# The beta project (valuedesk-beta) leaves no GitHub deployment for its preview builds (2026-11-02, 729e38c),
# only the commit status "Vercel – valuedesk-beta".
state=""
for _ in $(seq 1 60); do
  state="$(gh_api "$REPO/commits/$BETA_SHA/status" | json 'v && v.statuses ? ((v.statuses.find((s) => /valuedesk-beta/.test(s.context)) || {}).state || "") : ""')"
  case "$state" in success|failure|error) break ;; esac
  sleep 15
done
[ "$state" = success ] || die "the beta site's deployment is '${state:-not there}' after 15 minutes (Vercel dashboard)"
code="$(curl -s -o "$OUT_DIR/beta-check.html" -w '%{http_code}' --limit-rate 2M --max-time 20 "$BETA_SITE/" || true)"
rm -f "$OUT_DIR/beta-check.html"
[ "$code" = 200 ] || die "$BETA_SITE answers $code after the deployment"
mkdir -p "$OUT_DIR"
printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TAG" "${HEAD_SHA:0:7}" "ok" "beta" >> "$OUT_DIR/ships.log"
say "beta runs $TAG: $BETA_SITE. To everyone: bash deploy/release/ship-beta.sh promote $TAG --yes"

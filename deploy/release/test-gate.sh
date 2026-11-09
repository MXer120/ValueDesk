# deploy/release/test-gate.sh - sourced by release-server.sh: NO RELEASE WITHOUT GREEN TESTS
# (the owner, 2026-10-27: "all tests need to pass").
#
#   test_gate <tag>
#
# Passes when ONE of these holds, tried in this order:
#   1. GitHub Actions' CI (.github/workflows/ci.yml, job "test") passed for the tag's
#      commit. Asked through the GitHub API with GITHUB_TOKEN (or GH_TOKEN) - a token
#      that may read the repository's checks (fine-grained: "Checks: read-only" and
#      "Contents: read-only" on this repository). A run still going: it waits, up to 20 min.
#      A run that failed ONLY in a known network flake (deploy/release/ci-flake.mjs) is run again
#      once and waited for again (the job's log needs "Actions: read", the rerun "Actions: write");
#      without those rights it stops as before.
#   2. Without a token or a CI result: this checkout IS the tag - HEAD is the tag's commit
#      and nothing is changed or added under apps/, packages/, deploy/ or .github/ - and
#      deploy/ci/run-tests.mjs passes here and now (4-6 minutes).
# Otherwise it stops the release, and says why.
#
# EMERGENCIES: VS_SKIP_TESTS=1 releases without the gate. It is loud on purpose: a
# banner here, a line in deploy/.out/release-overrides.log (who, when, which tag,
# VS_SKIP_TESTS_REASON), and a line in the server's own journal (logger -t
# valuescan-release, kept a year), so it can always be found afterwards.

test_gate() {
  local tag="$1" sha repo token state waited=0
  sha="$(git rev-parse "refs/tags/$tag^{commit}")"

  if [ "${VS_SKIP_TESTS:-0}" = 1 ]; then
    {
      echo "################################################################################"
      echo "#  RELEASING $tag WITHOUT THE TEST GATE (VS_SKIP_TESTS=1)"
      echo "#  reason: ${VS_SKIP_TESTS_REASON:-<none given - set VS_SKIP_TESTS_REASON>}"
      echo "#  This is logged here, in deploy/.out/release-overrides.log, and on the server."
      echo "################################################################################"
    } >&2
    mkdir -p "$OUT_DIR"
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${USERNAME:-${USER:-?}}" "$tag" "$sha" "${VS_SKIP_TESTS_REASON:-}" >> "$OUT_DIR/release-overrides.log"
    TEST_GATE_SKIPPED=1
    return 0
  fi

  command -v node >/dev/null 2>&1 || die "the test gate needs node on PATH (export PATH=\"/c/Users/\$USERNAME/AppData/Local/ddx-tools/node-v24.22.1-win-x64:\$PATH\")"

  # --- 1. CI's verdict for the commit -------------------------------------------------------------
  token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  repo="$(git remote get-url origin 2>/dev/null | sed -E 's#^(https://([^@/]*@)?github\.com/|git@github\.com:)##; s#\.git$##')"
  if [ -n "$token" ] && [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    # THE ONE RERUN (2026-11-09): a CI run that failed ONLY in a known network flake (deploy/release/ci-flake.mjs
    # KNOWN_FLAKES) is run again once, and waited for again; any other failure, or the rerun failing too, stops the
    # release as before. `rerun_of`: the failed check runs' ids - GitHub lists them as the latest for a few seconds
    # after the rerun was asked for, and they are not the rerun's verdict.
    local rerun_of="" rerun_wait=0 urls ids
    while :; do
      state="$(GH_REPO="$repo" GH_SHA="$sha" GH_TOKEN_="$token" node --input-type=module -e '
        const r = await fetch(`https://api.github.com/repos/${process.env.GH_REPO}/commits/${process.env.GH_SHA}/check-runs?per_page=100`, {
          headers: { authorization: `Bearer ${process.env.GH_TOKEN_}`, accept: "application/vnd.github+json", "user-agent": "valuedesk-release" },
        }).catch((e) => ({ ok: false, status: 0, e }));
        if (!r.ok) { console.log(`error ${r.status}`); process.exit(0); }
        const runs = ((await r.json()).check_runs ?? []).filter((c) => c.name === "test");
        if (!runs.length) console.log("none");
        else if (runs.some((c) => c.status !== "completed")) console.log("pending");
        else console.log(runs.every((c) => c.conclusion === "success") ? "success" : `failure ${runs.map((c) => c.id).join(",")} ${runs.map((c) => c.html_url).join(" ")}`);
      ')"
      case "$state" in
        success) note "test gate: CI passed for $tag (${sha:0:12})${rerun_of:+ (on its one rerun)}"; return 0 ;;
        failure*)
          ids="${state#failure }"; ids="${ids%% *}"; urls="${state#failure "$ids"}"; urls="${urls# }"
          if [ -n "$rerun_of" ] && [ "$ids" = "$rerun_of" ] && [ "$rerun_wait" -lt 300 ]; then
            sleep 15; rerun_wait=$((rerun_wait + 15)); continue
          fi
          [ -z "$rerun_of" ] || die "test gate: CI FAILED for $tag (${sha:0:12}) again on its rerun: $urls - fix it, tag again, release that"
          local verdict
          if verdict="$(node deploy/release/ci-flake.mjs retry "$repo" $urls)"; then
            note "test gate: CI failed only in a known network flake - ${verdict#rerun: }; its failed job runs once more"
            rerun_of="$ids" waited=0
            sleep 15
            continue
          fi
          die "test gate: CI FAILED for $tag (${sha:0:12}): $urls - fix it, tag again, release that (${verdict:-no rerun})" ;;
        pending)
          [ "$waited" -lt 1200 ] || die "test gate: CI is still running for $tag after 20 minutes"
          [ "$waited" -gt 0 ] || note "test gate: CI is still running for $tag - waiting for it"
          sleep 30; waited=$((waited + 30)) ;;
        none) note "test gate: CI has no result for $tag (${sha:0:12}) - pushed? (git push origin $tag); trying the tests here"; break ;;
        *) note "test gate: no answer from GitHub that counts ($state: token or network) - trying the tests here"; break ;;
      esac
    done
  else
    note "test gate: no GITHUB_TOKEN - the tests run here"
  fi

  # --- 2. the tests, here, on exactly the tag ------------------------------------------------------
  [ "$(git rev-parse HEAD)" = "$sha" ] \
    || die "test gate: HEAD is not $tag, so the tests here would not test the tag. Check the tag out in a worktree of its own (git worktree add ../vs-$tag $tag), or set GITHUB_TOKEN so CI's result counts."
  local dirty
  dirty="$(git status --porcelain -- apps packages deploy .github package.json package-lock.json | grep -v '^?? deploy/\.out/' || true)"
  [ -z "$dirty" ] || die "test gate: this checkout has changes the tag does not - the tests would not test the tag:
$dirty"
  note "test gate: running deploy/ci/run-tests.mjs on $tag (logs: deploy/.out/ci/)"
  node deploy/ci/run-tests.mjs --jobs=2 || die "test gate: tests FAILED for $tag - nothing was released (deploy/.out/ci/<suite>.log)"
  note "test gate: every suite passed for $tag"
}

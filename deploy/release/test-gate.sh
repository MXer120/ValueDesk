# deploy/release/test-gate.sh - sourced by release-server.sh: NO RELEASE WITHOUT GREEN TESTS
# (the owner, 2026-10-27: "all tests need to pass").
#
#   test_gate <tag>
#
# THE TESTS RUN HERE, NOT ON GITHUB ACTIONS (the owner, 2026-11-24: no paying for GitHub): this checkout IS the tag -
# HEAD is the tag's commit and nothing is changed or added under apps/, packages/, deploy/ or .github/ - the installed
# packages are the lockfile's (deploy/ci/deps-check.mjs), and every suite of deploy/ci/run-tests.mjs passes (about 4
# minutes on the owner's PC). A run that failed ONLY in a known network flake (deploy/release/ci-flake.mjs) is run once
# more. A commit that passed is noted in deploy/.out/gate-passed.log and not tested again for 24 hours (a ship that
# stopped later and is started again). Otherwise it stops the release, and says why.
#
# EMERGENCIES: VS_SKIP_TESTS=1 releases without the gate. It is loud on purpose: a
# banner here, a line in deploy/.out/release-overrides.log (who, when, which tag,
# VS_SKIP_TESTS_REASON), and a line in the server's own journal (logger -t
# valuescan-release, kept a year), so it can always be found afterwards.

test_gate() {
  local tag="$1" sha
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

  # --- the tests, here, on exactly the tag ---------------------------------------------------------
  [ "$(git rev-parse HEAD)" = "$sha" ] \
    || die "test gate: HEAD is not $tag, so the tests here would not test the tag. Check the tag out in a worktree of its own (git worktree add ../vs-$tag $tag) and release from there."
  local dirty
  dirty="$(git status --porcelain -- apps packages deploy .github package.json package-lock.json | grep -v '^?? deploy/\.out/' || true)"
  [ -z "$dirty" ] || die "test gate: this checkout has changes the tag does not - the tests would not test the tag:
$dirty"
  # Only a pass of the last 24 hours counts (the tests read a network and a clock too).
  local log="$OUT_DIR/gate-passed.log" run="$OUT_DIR/gate-run.log" verdict
  mkdir -p "$OUT_DIR"
  if [ -f "$log" ] && awk -v s="$sha" -v since="$(( $(date -u +%s) - 86400 ))" '$1 == s && $2 >= since { f = 1 } END { exit !f }' "$log"; then
    note "test gate: every suite passed for $tag (${sha:0:12}) here already, within the last day"; return 0
  fi
  node deploy/ci/deps-check.mjs >&2 || die "test gate: the installed packages are not the lockfile's - npm ci, then again"
  note "test gate: running deploy/ci/run-tests.mjs on $tag (logs: deploy/.out/ci/)"
  # An environment of their own: not the release's settings, tokens and MSYS_NO_PATHCONV (lib.sh), with which 23 of the
  # deploy suite's tests fail on Windows (they hand /c/... paths to Windows programs).
  local clean=() v
  for v in PATH HOME USER USERNAME USERPROFILE HOMEDRIVE HOMEPATH SYSTEMROOT SystemRoot SYSTEMDRIVE SystemDrive WINDIR COMSPEC PATHEXT TEMP TMP TMPDIR APPDATA LOCALAPPDATA PROGRAMDATA LANG LC_ALL MSYSTEM; do
    [ -z "${!v:-}" ] || clean+=("$v=${!v}")
  done
  if ! env -i "${clean[@]}" node deploy/ci/run-tests.mjs --jobs=2 > "$run" 2>&1; then
    grep -E '^(FAIL|run-tests:|        x )' "$run" >&2 || true
    verdict="$(node deploy/release/ci-flake.mjs judge "$run")" \
      || die "test gate: tests FAILED for $tag - nothing was released (${verdict:-no verdict}; $run, deploy/.out/ci/<suite>.log)"
    note "test gate: only a known network flake failed - ${verdict#flake: }; once more"
    env -i "${clean[@]}" node deploy/ci/run-tests.mjs --jobs=2 > "$run" 2>&1 \
      || { grep -E '^(FAIL|run-tests:|        x )' "$run" >&2 || true; die "test gate: tests FAILED for $tag again - nothing was released ($run)"; }
  fi
  # Still the tag: another session may have moved or changed this checkout while the suites ran.
  dirty="$(git status --porcelain -- apps packages deploy .github package.json package-lock.json | grep -v '^?? deploy/\.out/' || true)"
  { [ "$(git rev-parse HEAD)" = "$sha" ] && [ -z "$dirty" ]; } \
    || die "test gate: this checkout changed while the tests ran - they did not test the tag; again"
  printf '%s %s %s\n' "$sha" "$(date -u +%s)" "$tag" >> "$log"
  note "test gate: every suite passed for $tag ($(tail -1 "$run"))"
}

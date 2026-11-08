#!/usr/bin/env bash
# Real Claude Code check for wait-anchor's $.store.
#
# Not claude plugin test, and not demo/host.ts. The plugin waits inside
# persistNote, before $.store.set or $.store.delete, when
# WAIT_ANCHOR_STORE_BARRIER is a directory. Each process writes:
#   arrive-<session-id>   entered persistNote
#   release-<session-id>  both arrivals are present; about to call $.store
#   done-<session-id>     $.store returned
# Times are milliseconds from $.clock.now(). Exit 0 requires both arrivals
# before either release, the two [release, done] intervals to overlap, and a
# new process to read each session. Exit 1 is a logged-in run that missed
# that. Exit 2 is a failed opening probe, including "Not logged in" and any
# other probe failure. Exit 2 is not a pass.
#
# Cases:
#   1. Two directories named app, different parents, different session ids.
#   2. One project directory, two session ids. set against set.
#   3. That same project, set against delete.
#
# Foreground --resume of one id can attach while that session is still open.
# That was observed: the second process exited 0, its session_id was the same
# UUID, and it read the note. That is not proof two writers of that key are
# safe. This script does not claim they are.
#
# --bg only: `claude --help` says `claude --bg --resume <session-id>` continues
# that session, or starts a copy and says so when it is already running.

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
plugin=$(cd "$here/.." && pwd)
claude=${CLAUDE:-claude}
work=${WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/wait-anchor-store.XXXXXX")}

say() { printf '%s\n' "$*"; }

probe_status=0
probe=$("$claude" -p 'hi' --max-turns 1 --output-format text 2>&1) || probe_status=$?
if [ "$probe_status" -ne 0 ]; then
  say "real-store-race: prerequisite failed (exit ${probe_status}). No store result."
  printf '%s\n' "$probe"
  exit 2
fi

mkdir -p "$work/left/app" "$work/right/app" "$work/same/app"
left_root="$work/left/app"
right_root="$work/right/app"
same_root="$work/same/app"
left_id=$(cat /proc/sys/kernel/random/uuid)
right_id=$(cat /proc/sys/kernel/random/uuid)
same_a=$(cat /proc/sys/kernel/random/uuid)
same_b=$(cat /proc/sys/kernel/random/uuid)
say "workdir $work"
say "different-roots $left_id $right_id"
say "same-project $same_a $same_b"

require() {
  local file=$1 needle=$2
  if ! grep -F -q -- "$needle" "$file"; then
    say "missing [$needle] in $file"
    say "workdir $work"
    exit 1
  fi
}

forbid() {
  local file=$1 needle=$2
  if grep -F -q -- "$needle" "$file"; then
    say "leaked [$needle] in $file"
    say "workdir $work"
    exit 1
  fi
}

# Both processes start immediately. The wait is inside persistNote.
pair() {
  local gate=$1
  local dir_a=$2 sid_a=$3 text_a=$4 out_a=$5
  local dir_b=$6 sid_b=$7 text_b=$8 out_b=$9
  local how_a=${10} how_b=${11}
  mkdir -p "$gate"
  one() {
    local how=$1 dir=$2 sid=$3 text=$4 out=$5
    (
      cd "$dir"
      if [ "$how" = first ]; then
        WAIT_ANCHOR_STORE_BARRIER="$gate" "$claude" --plugin-dir "$plugin" --session-id "$sid" -p "$text" --max-turns 1 --output-format text
      else
        WAIT_ANCHOR_STORE_BARRIER="$gate" "$claude" --plugin-dir "$plugin" --resume "$sid" -p "$text" --max-turns 1 --output-format text
      fi
    ) > "$out" 2>&1
  }
  one "$how_a" "$dir_a" "$sid_a" "$text_a" "$out_a" &
  local pa=$!
  one "$how_b" "$dir_b" "$sid_b" "$text_b" "$out_b" &
  local pb=$!
  wait "$pa"
  wait "$pb"
}

read_fresh() {
  local dir=$1 sid=$2 out=$3
  (
    cd "$dir"
    "$claude" --plugin-dir "$plugin" --resume "$sid" -p '/anchor' --max-turns 1 --output-format text
  ) > "$out" 2>&1
}

check_gate() {
  local gate=$1
  python3 - "$gate" << 'PY'
import pathlib, sys
gate = pathlib.Path(sys.argv[1])
def load(kind):
    found = []
    for path in sorted(gate.glob(kind + '-*')):
        op, ms = path.read_text().split()
        found.append((path.name[len(kind) + 1 :], op, int(ms)))
    return found
arrive, release, done = load('arrive'), load('release'), load('done')
print(f'gate {gate.name}')
for kind, rows in (('arrive', arrive), ('release', release), ('done', done)):
    for sid, op, ms in rows:
        print(f'  {kind} {sid} {op} {ms}')
if len(arrive) != 2 or len(release) != 2 or len(done) != 2:
    print('barrier: expected 2 arrive, 2 release, 2 done')
    sys.exit(1)
if max(ms for _, _, ms in arrive) > min(ms for _, _, ms in release):
    print('barrier: a store call was released before both writes had arrived')
    sys.exit(1)
a_rel, b_rel = release[0][2], release[1][2]
a_done, b_done = done[0][2], done[1][2]
if not (a_rel < b_done and b_rel < a_done):
    print('barrier: the two $.store intervals did not overlap')
    sys.exit(1)
print('barrier: both arrived before either release, and the store intervals overlapped')
PY
}

pair "$work/gate-roots" \
  "$left_root" "$left_id" '/anchor left goal · check: left check' "$work/left-set.txt" \
  "$right_root" "$right_id" '/anchor right goal · check: right check' "$work/right-set.txt" \
  first first
check_gate "$work/gate-roots"
read_fresh "$left_root" "$left_id" "$work/left-read.txt"
read_fresh "$right_root" "$right_id" "$work/right-read.txt"
require "$work/left-read.txt" 'left goal'
require "$work/left-read.txt" 'left check'
forbid "$work/left-read.txt" 'right goal'
require "$work/right-read.txt" 'right goal'
require "$work/right-read.txt" 'right check'
forbid "$work/right-read.txt" 'left goal'

pair "$work/gate-same-set" \
  "$same_root" "$same_a" '/anchor same-a goal · check: same-a check' "$work/same-a-set.txt" \
  "$same_root" "$same_b" '/anchor same-b goal · check: same-b check' "$work/same-b-set.txt" \
  first first
check_gate "$work/gate-same-set"
read_fresh "$same_root" "$same_a" "$work/same-a-read.txt"
read_fresh "$same_root" "$same_b" "$work/same-b-read.txt"
require "$work/same-a-read.txt" 'same-a goal'
forbid "$work/same-a-read.txt" 'same-b goal'
require "$work/same-b-read.txt" 'same-b goal'
forbid "$work/same-b-read.txt" 'same-a goal'

pair "$work/gate-same-delete" \
  "$same_root" "$same_a" '/anchor same-a again · check: same-a still' "$work/same-a-replace.txt" \
  "$same_root" "$same_b" '/anchor clear' "$work/same-b-clear.txt" \
  resume resume
check_gate "$work/gate-same-delete"
read_fresh "$same_root" "$same_a" "$work/same-a-after.txt"
read_fresh "$same_root" "$same_b" "$work/same-b-after.txt"
require "$work/same-a-after.txt" 'same-a again'
require "$work/same-a-after.txt" 'same-a still'
forbid "$work/same-a-after.txt" 'same-b goal'
require "$work/same-b-after.txt" "/anchor what you're doing · check: what to verify"
forbid "$work/same-b-after.txt" 'same-b goal'
forbid "$work/same-b-after.txt" 'same-a again'

say "real-store-race: barrier held at persistNote; fresh readers matched"
say "workdir $work"

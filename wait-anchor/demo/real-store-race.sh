#!/usr/bin/env bash
# Real Claude Code check for wait-anchor's $.store.
#
# This is not claude plugin test, and it is not the stand-in in demo/host.ts.
# Exit 0 means two different sessions wrote through the real store, then a new
# process read each session. Exit 2 means Claude Code is not logged in, and
# that is not a pass. Exit 1 means a logged-in run did not match.
#
# Same project, different session ids: each note has its own key. That is the
# isolation this script checks (set against set, then set against delete).
#
# Same session id, two processes: one key, two writers. claude --help says
# `claude --bg --resume <session-id>` continues that session, or starts a copy
# and says so when the session is already running. A copy is a different
# session. Concurrent --resume of one id is not a supported way to edit one note.
# This script does not start that pair. To record what this machine's CLI says:
#
#   claude --bg --session-id <uuid>
#   claude --bg --resume <uuid>
#
# Stop both with `claude stop <id>` if they stay up.

set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
plugin=$(cd "$here/.." && pwd)
claude=${CLAUDE:-claude}
work=${WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/wait-anchor-store.XXXXXX")}
barrier="$work/barrier"

say() { printf '%s\n' "$*"; }

probe_status=0
probe=$("$claude" -p 'hi' --max-turns 1 --output-format text 2>&1) || probe_status=$?
if [ "$probe_status" -ne 0 ]; then
  if printf '%s\n' "$probe" | grep -q 'Not logged in'; then
    say "real-store-race: not logged in. No store result."
  else
    say "real-store-race: claude probe failed ($probe_status). No store result."
    printf '%s\n' "$probe"
  fi
  exit 2
fi

mkdir -p "$barrier" "$work/left/app" "$work/right/app"
: > "$barrier/arrivals"
rm -f "$barrier/go"

arrive() {
  printf '%s\n' "$1" >> "$barrier/arrivals"
  while [ ! -f "$barrier/go" ]; do
    if [ "$(wc -l < "$barrier/arrivals")" -ge 2 ]; then
      printf 'go\n' > "$barrier/go"
      return 0
    fi
    sleep 0.05
  done
}

reset_barrier() {
  rm -f "$barrier/go"
  : > "$barrier/arrivals"
}

# First write of a new id. Both sides pass the barrier before Claude starts.
first_write() {
  local dir=$1 sid=$2 text=$3 out=$4
  arrive "$sid"
  (
    cd "$dir"
    "$claude" --plugin-dir "$plugin" --session-id "$sid" -p "$text" --max-turns 1 --output-format text
  ) > "$out" 2>&1
}

# A later process. --resume is a new process reading the stored session.
again() {
  local dir=$1 sid=$2 text=$3 out=$4
  arrive "$sid"
  (
    cd "$dir"
    "$claude" --plugin-dir "$plugin" --resume "$sid" -p "$text" --max-turns 1 --output-format text
  ) > "$out" 2>&1
}

read_fresh() {
  local dir=$1 sid=$2 out=$3
  (
    cd "$dir"
    "$claude" --plugin-dir "$plugin" --resume "$sid" -p '/anchor' --max-turns 1 --output-format text
  ) > "$out" 2>&1
}

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

left_id=$(cat /proc/sys/kernel/random/uuid)
right_id=$(cat /proc/sys/kernel/random/uuid)
left="$work/left/app"
right="$work/right/app"
say "workdir $work"
say "left $left_id"
say "right $right_id"

reset_barrier
first_write "$left" "$left_id" '/anchor left goal · check: left check' "$work/left-set.txt" &
pid_a=$!
first_write "$right" "$right_id" '/anchor right goal · check: right check' "$work/right-set.txt" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

read_fresh "$left" "$left_id" "$work/left-read.txt"
read_fresh "$right" "$right_id" "$work/right-read.txt"
require "$work/left-read.txt" 'left goal'
require "$work/left-read.txt" 'left check'
forbid "$work/left-read.txt" 'right goal'
require "$work/right-read.txt" 'right goal'
require "$work/right-read.txt" 'right check'
forbid "$work/right-read.txt" 'left goal'

reset_barrier
again "$left" "$left_id" '/anchor left again · check: left still' "$work/left-replace.txt" &
pid_a=$!
again "$right" "$right_id" '/anchor clear' "$work/right-clear.txt" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

read_fresh "$left" "$left_id" "$work/left-after.txt"
read_fresh "$right" "$right_id" "$work/right-after.txt"
require "$work/left-after.txt" 'left again'
require "$work/left-after.txt" 'left still'
forbid "$work/left-after.txt" 'right goal'
require "$work/right-after.txt" "/anchor what you're doing · check: what to verify"
forbid "$work/right-after.txt" 'right goal'
forbid "$work/right-after.txt" 'left again'

say "real-store-race: two sessions, fresh readers, set/set and set/delete ok"
say "workdir $work"

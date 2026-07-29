#!/usr/bin/env bash
#
# demo-panes.sh — build the demo pane layout in Herdr.
#
#   source dev/demo/pi-env.sh regtest    # optional, for the pi pane after
#   ./dev/demo/demo-panes.sh regtest
#
# Run this from the pane you want pi to live in. It splits two panes off to
# the right and leaves your focus where it was, so the pane you are sitting in
# stays the big one:
#
#   +-----------------------+------------+
#   |                       |  status    |   balances + meter
#   |   pi  (this pane)     +------------+
#   |                       |  proxy     |   aperture log, the 402s
#   +-----------------------+------------+
#
# It only creates panes. It does not start pi, so you keep control of when the
# demo actually begins.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${1:-regtest}"

if [[ "$PROFILE" != "signet" && "$PROFILE" != "regtest" ]]; then
	echo "usage: $0 {signet|regtest}" >&2
	exit 1
fi

# Herdr's own rule: only drive a session from inside it. Outside, the target
# would be whichever pane the UI happens to have focused, which may belong to
# someone else entirely.
if [[ "${HERDR_ENV:-}" != "1" ]]; then
	echo "not running inside Herdr (HERDR_ENV is not 1)." >&2
	echo "open the pi-402 workspace, then run this from the pane you want pi in." >&2
	exit 1
fi

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

# shellcheck source=/dev/null
source "$HERE/common.env"
STATE="$DEMO_DIR/$PROFILE"

if [[ ! -d "$STATE" ]]; then
	echo "no demo state at $STATE; run ./demo-up.sh $PROFILE first" >&2
	exit 1
fi

split() {
	# Echoes the new pane's ID. Focus stays put so the caller keeps the room's
	# attention on the pane they are already in.
	local target="$1" direction="$2" ratio="$3"
	herdr pane split "$target" --direction "$direction" --ratio "$ratio" \
		--cwd "$PWD" --no-focus | jq -r '.result.pane.pane_id'
}

echo "building the $PROFILE demo layout..."

# A narrow column on the right for the two read-only panes, leaving roughly
# two thirds for pi, which is where the room should be looking.
RIGHT="$(split "$HERDR_PANE_ID" right 0.38)"
PROXY="$(split "$RIGHT" down 0.5)"

herdr pane rename "$RIGHT" "status"  >/dev/null 2>&1 || true
herdr pane rename "$PROXY" "proxy"   >/dev/null 2>&1 || true

herdr pane run "$RIGHT" "$HERE/demo-watch.sh $PROFILE" >/dev/null
herdr pane run "$PROXY" "tail -f $STATE/aperture.log" >/dev/null

cat <<EOF

  layout ready
    status  $RIGHT   balances, payments, and the meter
    proxy   $PROXY   aperture log, where the 402s show up
    pi      $HERDR_PANE_ID   (this pane)

  Start pi here with:

    source $HERE/pi-env.sh $PROFILE
    pi -e "\$PI402_EXT" --model "\$DEMO_MODEL"

EOF

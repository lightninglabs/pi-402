#!/usr/bin/env bash
#
# demo-up.sh — bring up the pi-402 demo stack on signet or regtest.
#
#   ./demo-up.sh signet     # the one to demo on: no local chain, no lnd
#   ./demo-up.sh regtest    # the fallback: everything local
#
# Both profiles run the same four processes in a tmux session: the pricer, the
# proxy, and the two wallets. What changes between them is where the wallets
# point and whether a local chain has to be stood up first.
#
# Nothing here needs a Lightning node. Aperture mints its challenge invoices
# from the seller's Wavelength wallet, so the swap server supplies the inbound
# liquidity and the seller needs no channels of its own.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${1:-}"

if [[ "$PROFILE" != "signet" && "$PROFILE" != "regtest" ]]; then
	echo "usage: $0 {signet|regtest}" >&2
	exit 1
fi

# shellcheck source=/dev/null
source "$HERE/common.env"
# shellcheck source=/dev/null
source "$HERE/$PROFILE.env"

TMUX_SESSION="pi402-$PROFILE"
STATE="$DEMO_DIR/$PROFILE"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

# wait_for polls a health command until it succeeds, so each step starts
# against a dependency that is actually up rather than merely launched.
wait_for() {
	local what="$1" tries="$2"; shift 2
	for ((i = 1; i <= tries; i++)); do
		if "$@" >/dev/null 2>&1; then
			echo "    $what ready"
			return 0
		fi
		sleep 2
	done
	die "$what did not come up after $((tries * 2))s"
}

wallet_up() { curl -sf --max-time 5 -X POST "http://$1/v1/wallet/status" \
	-H 'Content-Type: application/json' -d '{}' -o /dev/null; }

# A wallet that exists but has no wallet file answers the status probe with a
# 400, so treat any HTTP answer as "the daemon is listening".
wallet_listening() { curl -s --max-time 5 -o /dev/null \
	-X POST "http://$1/v1/wallet/status" -H 'Content-Type: application/json' \
	-d '{}'; }

say "pi-402 demo: $PROFILE"
mkdir -p "$STATE" "$DEMO_DIR/bin"

# ---------------------------------------------------------------- checks ----
[[ -x "$WAVED_BIN" ]] || die "waved not found at $WAVED_BIN (build it with: make build tags=\"swapruntime wavewalletrpc\")"
[[ -x "$APERTURE_BIN" ]] || die "aperture not found at $APERTURE_BIN"
[[ -x "$LIGHTMETER_BIN" ]] || die "lightmeterd not found at $LIGHTMETER_BIN"
[[ -n "${!BASETEN_ENV_VAR:-}" ]] || die "\$$BASETEN_ENV_VAR is not set; aperture reads the model credential from its environment"
command -v tmux >/dev/null || die "tmux is required"

# ------------------------------------------------------------- the chain ----
if [[ "$DEMO_NEEDS_DOCKER" == "yes" ]]; then
	say "regtest: bringing up the local chain, operator and swap server"
	[[ -d "$LUMOS_DIR" ]] || die "lumos checkout not found at $LUMOS_DIR"

	( cd "$LUMOS_DIR" && LND_SOURCE="${LND_SOURCE:-$HOME/gocode/src/github.com/lightningnetwork/lnd}" \
		docker compose -f docker-compose.yml \
		-f "$HERE/../regtest/docker-compose.pi402.yml" up -d ) >/dev/null

	wait_for "bitcoind" 30 docker exec ark-bitcoind bitcoin-cli -regtest \
		-rpcuser=devuser -rpcpassword=devpass getblockchaininfo
	wait_for "ark operator" 30 docker exec ark-server \
		lumoscli --rpcserver=localhost:8081 info

	# Only fund on a fresh chain; re-running must not re-mine and re-send.
	if [[ "$(docker exec ark-bitcoind bitcoin-cli -regtest -rpcuser=devuser \
		-rpcpassword=devpass getblockcount)" -lt 110 ]]; then
		say "regtest: funding the local lnd wallets"
		( cd "$LUMOS_DIR" && ./scripts/docker-regtest-setup.sh ) >/dev/null
	fi

	# demo-fund.sh pays from lnd-server, but swapd's node is lnd-client, so
	# every funding payment routes over a channel between the two. The setup
	# script funds both wallets and opens nothing, and without the channel
	# every receive hangs with no useful error. Open one on a fresh chain.
	if [[ "$(docker exec ark-lnd-server lncli --network=regtest \
		listchannels | grep -c '"chan_id"')" -eq 0 ]]; then
		say "regtest: opening the lnd-server -> lnd-client channel"
		CLIENT_PUBKEY="$(docker exec ark-lnd-client lncli --network=regtest \
			--rpcserver=localhost:10010 getinfo \
			| sed -n 's/.*"identity_pubkey": *"\([0-9a-f]*\)".*/\1/p')"
		docker exec ark-lnd-server lncli --network=regtest connect \
			"$CLIENT_PUBKEY@lnd-client:9736" >/dev/null 2>&1 || true
		docker exec ark-lnd-server lncli --network=regtest openchannel \
			--node_key="$CLIENT_PUBKEY" --local_amt=16000000 \
			--push_amt=8000000 >/dev/null
		docker exec ark-bitcoind bitcoin-cli -regtest -rpcuser=devuser \
			-rpcpassword=devpass -generate 6 >/dev/null
	fi
else
	say "signet: using the public operator, swap server and chain source"
	echo "    nothing local to start"
fi

# ----------------------------------------------------------------- tmux -----
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
tmux new-session -d -s "$TMUX_SESSION" -n pricer -c "$STATE"

run_in() {
	local window="$1"; shift
	tmux new-window -t "$TMUX_SESSION" -n "$window" -c "$STATE" 2>/dev/null || true
	# A brief pause lets the pane's shell finish starting before it is fed a
	# command, which otherwise gets typed into a shell that is not reading.
	sleep 1
	tmux send-keys -t "$TMUX_SESSION:$window" "$*" C-m
}

# Nothing on regtest mines by itself, so funding transactions and boarding
# outputs would sit unconfirmed forever and swap provisioning would stall.
if [[ "$DEMO_NEEDS_DOCKER" == "yes" ]]; then
	run_in miner "while true; do docker exec ark-bitcoind bitcoin-cli -regtest \
-rpcuser=devuser -rpcpassword=devpass -generate 1 >/dev/null; sleep 30; done"
fi

say "starting the pricer"
tmux send-keys -t "$TMUX_SESSION:pricer" \
	"$LIGHTMETER_BIN --config $HERE/$LIGHTMETER_CONFIG 2>&1 | tee $STATE/lightmeter.log" C-m

# --------------------------------------------------------------- wallets ----
waved_cmd() {
	local datadir="$1" rpc="$2" gateway="$3"
	echo "$WAVED_BIN $WAVED_NET_FLAGS --datadir=$datadir \
--wallet.type=lwwallet \
--swap.databasefilename=$datadir/swaps.db \
--rpc.listenaddr=$rpc --rpc.notls --rpc.no-macaroons \
--rpc.gateway.enabled --rpc.gateway.listenaddr=$gateway"
}

say "starting the seller wallet (aperture mints its invoices from this one)"
run_in seller-wallet "$(waved_cmd "$STATE/seller-wallet" "$SELLER_RPC" "$SELLER_GATEWAY_HOST") 2>&1 | tee $STATE/seller-wallet.log"

say "starting the buyer wallet (pi pays from this one)"
run_in buyer-wallet "$(waved_cmd "$STATE/buyer-wallet" "$BUYER_RPC" "$BUYER_GATEWAY_HOST") 2>&1 | tee $STATE/buyer-wallet.log"

say "starting the user wallet (stands in for the phone that funds the harness)"
run_in user-wallet "$(waved_cmd "$STATE/user-wallet" "$USER_RPC" "$USER_GATEWAY_HOST") 2>&1 | tee $STATE/user-wallet.log"

wait_for "seller wallet" 45 wallet_listening "$SELLER_GATEWAY_HOST"
wait_for "buyer wallet"  45 wallet_listening "$BUYER_GATEWAY_HOST"
wait_for "user wallet"   45 wallet_listening "$USER_GATEWAY_HOST"

# Bring each wallet to a usable state, creating one only on the very first run.
#
# Order matters here. The status probe answers WALLET_NOT_READY both when no
# wallet exists and when one exists but is locked, and the two differ only in
# the prose ("create first" vs "unlock first"). So unlock is tried first and
# create is reached only when unlock reports there is no wallet at all
# (state=none). Reading a failed probe as "no wallet" instead would try to
# create one over an existing wallet on every restart.
ensure_wallet() {
	local name="$1" host="$2"
	local pw body code
	pw="$(printf %s "$PI402_WALLET_PASSWORD" | base64)"

	if wallet_up "$host"; then
		echo "    $name wallet already unlocked"
		return 0
	fi

	body="$STATE/.$name-unlock.json"
	code="$(curl -s -o "$body" -w '%{http_code}' --max-time 60 \
		-X POST "http://$host/v1/wallet/unlock" \
		-H 'Content-Type: application/json' \
		-d "{\"wallet_password\":\"$pw\"}")"

	if [[ "$code" == "200" ]]; then
		echo "    $name wallet unlocked"
		return 0
	fi

	if ! grep -q 'state=none' "$body" 2>/dev/null; then
		die "could not unlock the $name wallet: $(cat "$body" 2>/dev/null)"
	fi

	echo "    creating the $name wallet"
	curl -sf --max-time 120 -X POST "http://$host/v1/wallet/create" \
		-H 'Content-Type: application/json' \
		-d "{\"wallet_password\":\"$pw\"}" \
		-o "$STATE/$name-wallet-created.json" \
		|| die "could not create the $name wallet"
}

# The seller has to be usable before aperture can mint from it; pi unlocks the
# buyer itself on session start, but doing it here keeps the two symmetric and
# surfaces a bad password now rather than mid-demo.
ensure_wallet seller "$SELLER_GATEWAY_HOST"
ensure_wallet buyer "$BUYER_GATEWAY_HOST"
ensure_wallet user "$USER_GATEWAY_HOST"

say "starting aperture"
run_in aperture "cd $STATE && $APERTURE_BIN --configfile=$HERE/$APERTURE_CONFIG 2>&1 | tee $STATE/aperture.log"
wait_for "aperture" 30 curl -s --max-time 5 -o /dev/null "http://$APERTURE_ADDR/v1/chat/completions"

# ---------------------------------------------------------------- ready -----
say "sanity check: a 402 with no credential and no prior payment"
CHALLENGE="$(curl -si --max-time 30 "http://$APERTURE_ADDR/v1/chat/completions" \
	-H 'Content-Type: application/json' \
	-d '{"model":"moonshotai/Kimi-K3","messages":[{"role":"user","content":"hi"}]}' || true)"

if grep -qi '402 Payment Required' <<<"$CHALLENGE"; then
	echo "    402 received, invoice minted from the seller wallet"
	grep -oiE 'invoice="ln[a-z0-9]{12}' <<<"$CHALLENGE" | head -1 | sed 's/^/    /'
else
	echo "    WARNING: expected a 402, got:"
	head -3 <<<"$CHALLENGE" | sed 's/^/    /'
fi

BUYER_BAL="$(curl -s --max-time 10 -X POST "http://$BUYER_GATEWAY_HOST/v1/wallet/balance" \
	-H 'Content-Type: application/json' -d '{}' \
	| sed -n 's/.*"confirmed_sat":"\([0-9]*\)".*/\1/p')"

cat <<EOF

  profile     $PROFILE
  tmux        tmux attach -t $TMUX_SESSION
  state       $STATE
  buyer       ${BUYER_BAL:-unknown} sat   (gateway $BUYER_GATEWAY_HOST)
  seller      gateway $SELLER_GATEWAY_HOST
  user        gateway $USER_GATEWAY_HOST   (the phone stand-in)
  funding     $DEMO_FUNDING

  Run pi against it with:

    export L402_PROXY_URL=http://$APERTURE_ADDR/v1
    export PI402_WALLETD_GATEWAY=http://$BUYER_GATEWAY_HOST
    export PI402_DATA_DIR=$STATE/pi-data
    export PI402_NETWORK=$PI402_NETWORK
    export PI402_MAX_SAT_PER_REQUEST=$PI402_MAX_SAT_PER_REQUEST
    export PI402_WALLET_PASSWORD=$PI402_WALLET_PASSWORD
    pi -e $PI402_EXT --model $DEMO_MODEL

  Then /fund <sats> in pi, pay the invoice, and /balance to watch it land.

EOF

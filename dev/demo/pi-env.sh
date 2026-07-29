# Sourced, not run: sets up the environment pi needs to talk to the demo stack.
#
#   source dev/demo/pi-env.sh regtest
#   pi -e "$PI402_EXT" --model "$DEMO_MODEL"
#
# Kept separate from the launch itself so the pi pane is one readable line
# rather than six exports scrolling past during a demo.

_pi_env_profile="${1:-regtest}"
_pi_env_here="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")" && pwd)"

# shellcheck source=/dev/null
source "$_pi_env_here/common.env"
# shellcheck source=/dev/null
source "$_pi_env_here/$_pi_env_profile.env"

export L402_PROXY_URL="http://$APERTURE_ADDR/v1"
export PI402_WALLETD_GATEWAY="http://$BUYER_GATEWAY_HOST"
export PI402_DATA_DIR="$DEMO_DIR/$_pi_env_profile/pi-data"
export PI402_NETWORK
export PI402_MAX_SAT_PER_REQUEST
export PI402_DAILY_CAP_SAT
export PI402_WALLET_PASSWORD
export PI402_EXT
export DEMO_MODEL

echo "pi-402 $_pi_env_profile: proxy $L402_PROXY_URL, wallet $PI402_WALLETD_GATEWAY"
echo "run: pi -e \"\$PI402_EXT\" --model \"\$DEMO_MODEL\""

unset _pi_env_profile _pi_env_here

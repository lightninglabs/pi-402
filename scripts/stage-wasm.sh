#!/usr/bin/env bash
#
# stage-wasm.sh copies the embedded wallet's WASM bundle into ./wasm so that it
# ships inside the npm package, and checks that the bundle is complete.
#
#   scripts/stage-wasm.sh <path-to-wavelength-bin/wasm>   stage a built bundle
#   scripts/stage-wasm.sh --verify                        check ./wasm only
#
# The bundle comes from `make wasm-wallet` in wavelength, which writes it to
# bin/wasm. It is about 137 MB raw, so it is git-ignored and travels only in
# the npm tarball. `npm publish` runs --verify through the prepublishOnly
# script, so a package without the wallet cannot be published.
#
# The file list below mirrors WASM_ASSETS in src/wallet.ts. Keep the two in
# step: the extension refuses to load a bundle that lacks any of them.
#
# This script also writes wasm/package.json, containing {"type":"commonjs"}.
# JSON has no comments, so the reason lives here. pi-402 declares
# "type": "module", and Node decides how to load a .js file from the nearest
# enclosing package.json. Without its own, the bundle's .js files inherit
# "module", and the SQLite worker's require() of sqlite3.js and
# sqlite-node-vfs.js then fails. That surfaces as the opaque "wasmsqlite:
# sqlite worker initialization failed: <object>". The bundle is CommonJS, so
# it carries a package.json saying so. wasm/package.json is also what
# assertWasmDirIsCommonJs in src/wallet.ts looks for.

set -euo pipefail

ASSETS=(
	wasm_exec.js
	wavewalletdk.wasm
	sqlite3.js
	sqlite3.wasm
	sqlite-bridge.js
	sqlite-worker.js
	sqlite-node-vfs.js
)

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$root/wasm"

# verify fails unless every asset and the CommonJS marker are present.
verify() {
	local missing=()
	local name
	for name in "${ASSETS[@]}" package.json; do
		[[ -s "$dest/$name" ]] || missing+=("$name")
	done

	if ((${#missing[@]} > 0)); then
		echo "error: $dest is incomplete, missing: ${missing[*]}" >&2
		echo "run scripts/stage-wasm.sh <path-to-wavelength-bin/wasm> first" >&2
		return 1
	fi

	if ! grep -q '"type"[[:space:]]*:[[:space:]]*"commonjs"' "$dest/package.json"; then
		echo "error: $dest/package.json does not declare \"type\": \"commonjs\"" >&2
		return 1
	fi
}

if [[ "${1:-}" == "--verify" ]]; then
	verify
	exit 0
fi

if [[ $# -ne 1 || ! -d "$1" ]]; then
	echo "usage: $0 <path-to-wavelength-bin/wasm> | --verify" >&2
	exit 2
fi

src="$1"
mkdir -p "$dest"
for name in "${ASSETS[@]}"; do
	if [[ ! -f "$src/$name" ]]; then
		echo "error: $src is missing $name; rebuild with \`make wasm-wallet\`" >&2
		exit 1
	fi
	cp "$src/$name" "$dest/$name"
done

printf '{"type":"commonjs"}\n' >"$dest/package.json"

verify
echo "staged ${#ASSETS[@]} files into $dest"

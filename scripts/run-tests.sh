#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

temp_parent="${TMPDIR:-/tmp}"
temp_parent="${temp_parent%/}"
test_root="$(mktemp -d "$temp_parent/gama-test.XXXXXX")"
git_askpass="$(type -P false)"
readonly temp_parent test_root git_askpass

native_path() {
	if command -v cygpath > /dev/null 2>&1; then
		cygpath -w "$1"
	else
		printf "%s\n" "$1"
	fi
}

home_dir="$(native_path "$test_root/home")"
tmp_dir="$(native_path "$test_root/tmp")"
cache_dir="$(native_path "$test_root/cache")"

mkdir -p "$test_root/home/.config" "$test_root/tmp" "$test_root/cache/npm"
touch "$test_root/.gama-test-owned" "$test_root/npm-userconfig" "$test_root/npm-globalconfig"

cleanup() {
	local status=$?
	trap - EXIT

	case "$test_root" in
		"$temp_parent"/gama-test.*)
			if [[ -d "$test_root" && ! -L "$test_root" && -f "$test_root/.gama-test-owned" ]]; then
				rm -rf -- "$test_root"
			else
				printf "Refusing to remove unverified test directory: %s\n" "$test_root" >&2
				[[ $status -ne 0 ]] || status=1
			fi
			;;
		*)
			printf "Refusing to remove unexpected test directory: %s\n" "$test_root" >&2
			[[ $status -ne 0 ]] || status=1
			;;
	esac

	exit "$status"
}
trap cleanup EXIT

test_env=(
	"PATH=$PATH"
	"PWD=$PWD"
	"HOME=$home_dir"
	"USERPROFILE=$home_dir"
	"TMPDIR=$tmp_dir"
	"TMP=$tmp_dir"
	"TEMP=$tmp_dir"
	"XDG_CONFIG_HOME=$(native_path "$test_root/home/.config")"
	"XDG_CACHE_HOME=$cache_dir"
	"LANG=C"
	"LC_ALL=C"
	"TZ=UTC"
	"GIT_CONFIG_NOSYSTEM=1"
	"GIT_CONFIG_GLOBAL=/dev/null"
	"GIT_TERMINAL_PROMPT=0"
	"GIT_ASKPASS=$git_askpass"
	"GIT_EDITOR=true"
	"GIT_SEQUENCE_EDITOR=true"
	"NPM_CONFIG_USERCONFIG=$(native_path "$test_root/npm-userconfig")"
	"NPM_CONFIG_GLOBALCONFIG=$(native_path "$test_root/npm-globalconfig")"
	"NPM_CONFIG_CACHE=$cache_dir/npm"
	"GAMA_NO_LOCAL_LLM=1"
	"AWS_EC2_METADATA_DISABLED=true"
)

for name in SystemRoot SYSTEMROOT WINDIR COMSPEC PATHEXT; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

for name in ALL_PROXY HTTP_PROXY HTTPS_PROXY NO_PROXY all_proxy http_proxy https_proxy no_proxy; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

for name in CI GITHUB_ACTIONS; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

echo "Running tests without API keys in isolated home: $test_root/home"

if ! env -i "${test_env[@]}" node scripts/provision-test-tools.mjs; then
	echo "Continuing without tool provisioning: offline machines rely on system ripgrep." >&2
fi

env -i "${test_env[@]}" npm test

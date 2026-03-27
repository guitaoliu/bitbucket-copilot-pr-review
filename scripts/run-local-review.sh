#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/run-local-review.sh <repo-root> <bitbucket-pr-url>

Examples:
  scripts/run-local-review.sh ~/code/my-repo \
    https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123

Required environment:
  BITBUCKET_TOKEN        Bitbucket token

Alternative Bitbucket auth:
  BITBUCKET_USERNAME
  BITBUCKET_PASSWORD

Copilot authentication:
  Use an existing Copilot or GitHub CLI login, or set a standard
  GitHub token env var supported by the Copilot SDK if preferred.

Optional environment:
  PUBLISH=1                    Publish to Bitbucket instead of dry-run
  FORCE_REVIEW=1               Force a rerun even if this commit already has the report key
  CONFIRM_RERUN=1              Prompt only when rerunning unusable cached artifacts for the current unchanged PR head and revision
  CI_SUMMARY_PATH=/tmp/ci.txt  Include CI context in the review
  NODE_USE_SYSTEM_CA=0         Override the default system CA loading for Node.js
  BITBUCKET_CA_CERT_PATH=/path/to/corp-ca.pem
  BITBUCKET_INSECURE_TLS=0     Re-enable strict TLS verification after trust is configured
  COPILOT_MODEL=gpt-5.4
  COPILOT_REASONING_EFFORT=xhigh
  LOG_LEVEL=debug
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || die "Missing required command: $command_name"
}

if [[ $# -ne 2 ]]; then
  usage >&2
  exit 64
fi

require_command git
require_command node
require_command pnpm

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REVIEWER_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

TARGET_REPO_INPUT="$1"
PR_URL_RAW="$2"

TARGET_REPO_ROOT="$(cd -- "$TARGET_REPO_INPUT" && pwd -P)" || die "Repository path does not exist: $TARGET_REPO_INPUT"

git -C "$TARGET_REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "Not a git repository: $TARGET_REPO_ROOT"

if [[ -z "${BITBUCKET_TOKEN:-}" && ( -z "${BITBUCKET_USERNAME:-}" || -z "${BITBUCKET_PASSWORD:-}" ) ]]; then
  die "Set BITBUCKET_TOKEN or BITBUCKET_USERNAME and BITBUCKET_PASSWORD before running this script"
fi

PR_URL="${PR_URL_RAW%%\?*}"
PR_URL="${PR_URL%%#*}"
PR_URL="${PR_URL%/}"

if [[ ! "$PR_URL" =~ ^https?://.+/projects/[^/]+/repos/[^/]+/pull-requests/[0-9]+$ ]]; then
  die "Bitbucket PR URL must look like https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123"
fi

export REPO_ROOT="$TARGET_REPO_ROOT"
export COPILOT_MODEL="${COPILOT_MODEL:-gpt-5.4}"
export COPILOT_REASONING_EFFORT="${COPILOT_REASONING_EFFORT:-xhigh}"
export LOG_LEVEL="${LOG_LEVEL:-debug}"
export NODE_USE_SYSTEM_CA="${NODE_USE_SYSTEM_CA:-1}"

declare -a REVIEW_ARGS=(review "$PR_URL")

if [[ "${PUBLISH:-0}" == "1" ]]; then
  :
else
  REVIEW_ARGS+=(--dry-run)
fi

if [[ "${FORCE_REVIEW:-0}" == "1" ]]; then
  REVIEW_ARGS+=(--force-review)
fi

if [[ "${CONFIRM_RERUN:-0}" == "1" ]]; then
  REVIEW_ARGS+=(--confirm-rerun)
fi

printf 'Reviewer root: %s\n' "$REVIEWER_ROOT"
printf 'Target repo: %s\n' "$REPO_ROOT"
printf 'Bitbucket PR: %s\n' "$PR_URL"
printf 'Model: %s\n' "$COPILOT_MODEL"
printf 'Reasoning effort: %s\n' "$COPILOT_REASONING_EFFORT"
printf 'Node system CA: %s\n' "$( [[ "$NODE_USE_SYSTEM_CA" == "1" ]] && printf 'enabled' || printf 'disabled' )"
printf 'Mode: %s\n' "$( [[ "${PUBLISH:-0}" == "1" ]] && printf 'publish' || printf 'dry-run' )"
printf 'Force review: %s\n' "$( [[ "${FORCE_REVIEW:-0}" == "1" ]] && printf 'enabled' || printf 'disabled' )"
printf 'Confirm rerun: %s\n' "$( [[ "${CONFIRM_RERUN:-0}" == "1" ]] && printf 'enabled' || printf 'disabled' )"
if [[ -n "${BITBUCKET_CA_CERT_PATH:-}" ]]; then
  printf 'Bitbucket CA cert: %s\n' "$BITBUCKET_CA_CERT_PATH"
fi
if [[ "${BITBUCKET_INSECURE_TLS:-1}" == "0" ]]; then
  printf 'Bitbucket TLS verification: strict\n'
else
  printf 'Bitbucket TLS verification: insecure skip verify enabled\n'
fi

declare -a REVIEW_COMMAND=(node "$REVIEWER_ROOT/src/cli.ts")
if (( ${#REVIEW_ARGS[@]} > 0 )); then
  REVIEW_COMMAND+=("${REVIEW_ARGS[@]}")
fi

"${REVIEW_COMMAND[@]}"

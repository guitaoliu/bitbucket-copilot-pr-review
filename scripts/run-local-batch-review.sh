#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/run-local-batch-review.sh <repository-url>

Examples:
  scripts/run-local-batch-review.sh \
    https://bitbucket.example.com/projects/AAAS/repos/sbp

Required environment:
  BITBUCKET_TOKEN         Bitbucket token

Alternative Bitbucket auth:
  BITBUCKET_USERNAME
  BITBUCKET_PASSWORD

Copilot authentication:
  Use an existing Copilot or GitHub CLI login, or set a standard
  GitHub token env var supported by the Copilot SDK if preferred.

Optional environment:
  PUBLISH=1                    Publish to Bitbucket instead of dry-run
  FORCE_REVIEW=1               Force reruns for already-reviewed PR revisions
  MAX_PARALLEL=2               Concurrent batch review workers
  TEMP_ROOT=/tmp/review-batch  Parent directory for temp clone/cache data
  KEEP_WORKDIRS=1              Preserve per-PR workdirs after the run
  NODE_USE_SYSTEM_CA=0         Override the default system CA loading for Node.js
  BITBUCKET_CA_CERT_PATH=/path/to/corp-ca.pem
  BITBUCKET_INSECURE_TLS=0     Re-enable strict TLS verification after trust is configured
  COPILOT_MODEL=gpt-5.4
  COPILOT_REASONING_EFFORT=xhigh
  LOG_LEVEL=debug
  REPORT_KEY=copilot-local-$USER
  REPORT_TITLE='Copilot PR Review (local batch)'
  REPORTER_NAME='GitHub Copilot Local Batch Test'

Notes:
  - Batch mode clones the target repo automatically; no local checkout is required.
  - Batch mode uses the `batch` subcommand and does not support rerun confirmation.
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

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 64
fi

require_command git
require_command node
require_command pnpm

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REVIEWER_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

REPO_URL_RAW="$1"
REPO_URL="${REPO_URL_RAW%%\?*}"
REPO_URL="${REPO_URL%%#*}"
REPO_URL="${REPO_URL%/}"

if [[ ! "$REPO_URL" =~ ^https?://.+/projects/[^/]+/repos/[^/]+$ ]]; then
  die "Repository URL must look like https://bitbucket.example.com/projects/AAAS/repos/sbp"
fi

if [[ -z "${BITBUCKET_TOKEN:-}" && ( -z "${BITBUCKET_USERNAME:-}" || -z "${BITBUCKET_PASSWORD:-}" ) ]]; then
  die "Set BITBUCKET_TOKEN or BITBUCKET_USERNAME and BITBUCKET_PASSWORD before running this script"
fi

if [[ "${CONFIRM_RERUN:-0}" == "1" ]]; then
  die "Batch mode does not support CONFIRM_RERUN"
fi

if [[ -n "${MAX_PARALLEL:-}" ]]; then
  if [[ ! "$MAX_PARALLEL" =~ ^[0-9]+$ || "$MAX_PARALLEL" == "0" ]]; then
    die "MAX_PARALLEL must be a positive integer"
  fi
fi

export COPILOT_MODEL="${COPILOT_MODEL:-gpt-5.4}"
export COPILOT_REASONING_EFFORT="${COPILOT_REASONING_EFFORT:-xhigh}"
export LOG_LEVEL="${LOG_LEVEL:-debug}"
export REPORT_KEY="${REPORT_KEY:-copilot-local-${USER:-local}}"
export NODE_USE_SYSTEM_CA="${NODE_USE_SYSTEM_CA:-1}"

declare -a REVIEW_ARGS=(batch "$REPO_URL")

if [[ "${PUBLISH:-0}" == "1" ]]; then
  export REPORT_TITLE="${REPORT_TITLE:-Copilot PR Review (local batch)}"
  export REPORTER_NAME="${REPORTER_NAME:-GitHub Copilot Local Batch Test}"
else
  export REPORT_TITLE="${REPORT_TITLE:-Copilot PR Review (local batch dry run)}"
  export REPORTER_NAME="${REPORTER_NAME:-GitHub Copilot Local Batch Dry Run}"
  REVIEW_ARGS+=(--dry-run)
fi

if [[ "${FORCE_REVIEW:-0}" == "1" ]]; then
  REVIEW_ARGS+=(--force-review)
fi

if [[ "${KEEP_WORKDIRS:-0}" == "1" ]]; then
  REVIEW_ARGS+=(--keep-workdirs)
fi

if [[ -n "${MAX_PARALLEL:-}" ]]; then
  REVIEW_ARGS+=(--max-parallel "$MAX_PARALLEL")
fi

if [[ -n "${TEMP_ROOT:-}" ]]; then
  REVIEW_ARGS+=(--temp-root "$TEMP_ROOT")
fi

printf 'Reviewer root: %s\n' "$REVIEWER_ROOT"
printf 'Repository URL: %s\n' "$REPO_URL"
printf 'Model: %s\n' "$COPILOT_MODEL"
printf 'Reasoning effort: %s\n' "$COPILOT_REASONING_EFFORT"
printf 'Node system CA: %s\n' "$( [[ "$NODE_USE_SYSTEM_CA" == "1" ]] && printf 'enabled' || printf 'disabled' )"
printf 'Mode: %s\n' "$( [[ "${PUBLISH:-0}" == "1" ]] && printf 'publish' || printf 'dry-run' )"
printf 'Force review: %s\n' "$( [[ "${FORCE_REVIEW:-0}" == "1" ]] && printf 'enabled' || printf 'disabled' )"
printf 'Keep workdirs: %s\n' "$( [[ "${KEEP_WORKDIRS:-0}" == "1" ]] && printf 'enabled' || printf 'disabled' )"
printf 'Max parallel: %s\n' "${MAX_PARALLEL:-2}"
if [[ -n "${TEMP_ROOT:-}" ]]; then
  printf 'Temp root: %s\n' "$TEMP_ROOT"
fi
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

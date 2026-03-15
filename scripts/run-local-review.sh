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
  COPILOT_GITHUB_TOKEN   GitHub token with Copilot access
  BITBUCKET_TOKEN        Bitbucket token

Alternative Bitbucket auth:
  BITBUCKET_USERNAME
  BITBUCKET_PASSWORD

Optional environment:
  PUBLISH=1                    Publish to Bitbucket instead of dry-run
  FORCE_REVIEW=1               Force a rerun even if this commit already has the report key
  CONFIRM_RERUN=1              Prompt only when rerunning unusable cached artifacts for the current unchanged PR head and revision
  CI_SUMMARY_PATH=/tmp/ci.txt  Include CI context in the review
  BITBUCKET_CA_CERT_PATH=/path/to/corp-ca.pem
  BITBUCKET_INSECURE_TLS=0     Re-enable strict TLS verification after trust is configured
  COPILOT_MODEL=gpt-5.4
  COPILOT_REASONING_EFFORT=xhigh
  LOG_LEVEL=debug
  REPORT_KEY=copilot-local-$USER
  REPORT_TITLE='Copilot PR Review (local)'
  REPORTER_NAME='GitHub Copilot Local Test'
  REPORT_LINK=https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123
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

if [[ -z "${COPILOT_GITHUB_TOKEN:-}" ]]; then
  die "Set COPILOT_GITHUB_TOKEN before running this script"
fi

if [[ -z "${BITBUCKET_TOKEN:-}" && ( -z "${BITBUCKET_USERNAME:-}" || -z "${BITBUCKET_PASSWORD:-}" ) ]]; then
  die "Set BITBUCKET_TOKEN or BITBUCKET_USERNAME and BITBUCKET_PASSWORD before running this script"
fi

PR_URL="${PR_URL_RAW%%\?*}"
PR_URL="${PR_URL%/}"

if [[ ! "$PR_URL" =~ ^(https?://[^/]+)/projects/([^/]+)/repos/([^/]+)/pull-requests/([0-9]+)$ ]]; then
  die "Bitbucket PR URL must look like https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123"
fi

export REPO_ROOT="$TARGET_REPO_ROOT"
export BITBUCKET_BASE_URL="${BASH_REMATCH[1]}"
export BITBUCKET_PROJECT_KEY="${BASH_REMATCH[2]}"
export BITBUCKET_REPO_SLUG="${BASH_REMATCH[3]}"
export BITBUCKET_PR_ID="${BASH_REMATCH[4]}"

export COPILOT_MODEL="${COPILOT_MODEL:-gpt-5.4}"
export COPILOT_REASONING_EFFORT="${COPILOT_REASONING_EFFORT:-xhigh}"
export LOG_LEVEL="${LOG_LEVEL:-debug}"
export REPORT_KEY="${REPORT_KEY:-copilot-local-${USER:-local}}"
export REPORT_LINK="${REPORT_LINK:-$PR_URL}"

declare -a REVIEW_ARGS=()

if [[ "${PUBLISH:-0}" == "1" ]]; then
  export REPORT_TITLE="${REPORT_TITLE:-Copilot PR Review (local)}"
  export REPORTER_NAME="${REPORTER_NAME:-GitHub Copilot Local Test}"
else
  export REPORT_TITLE="${REPORT_TITLE:-Copilot PR Review (local dry run)}"
  export REPORTER_NAME="${REPORTER_NAME:-GitHub Copilot Local Dry Run}"
  REVIEW_ARGS=(--dry-run)
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

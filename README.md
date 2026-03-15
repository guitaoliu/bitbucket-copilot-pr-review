# Bitbucket Copilot PR Review

Automated Bitbucket Data Center pull request review for Jenkins, powered by the GitHub Copilot SDK.

## What it does

- reads PR metadata from Bitbucket Data Center
- computes the PR diff locally from the Jenkins workspace
- asks Copilot to review only the changed PR scope through read-only custom tools
- publishes the result as Bitbucket Code Insights reports and annotations

## Runtime requirements

- Node.js 22+
- pnpm 10+
- `copilot` CLI installed on the Jenkins agent and available in `PATH`
- a GitHub Copilot-enabled account for CI

## Required credentials

- `COPILOT_GITHUB_TOKEN` for Copilot SDK and CLI authentication
- `BITBUCKET_TOKEN` for Bitbucket Data Center REST API access

If your Bitbucket environment requires basic auth instead of bearer tokens, provide `BITBUCKET_USERNAME` and `BITBUCKET_PASSWORD` and set `BITBUCKET_AUTH_TYPE=basic`.

<!-- GENERATED_CONFIG_REFERENCE:START -->
## Configuration Reference

### CLI options

| Option | Description |
| --- | --- |
| `--dry-run`, `--no-publish` | Run the review but skip Bitbucket publishing |
| `--force-review` | Run even if the current PR revision already has a fully published result |
| `--confirm-rerun` | Prompt only when rerunning unusable cached artifacts for the current unchanged PR head and revision |
| `--repo-root <path>` | Path to the repository under review |
| `-h`, `--help` | Show this help text |

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `BITBUCKET_BASE_URL` | required | Bitbucket Data Center base URL. |
| `BITBUCKET_PROJECT_KEY` | required | Bitbucket project key. |
| `BITBUCKET_REPO_SLUG` | required | Bitbucket repository slug. |
| `BITBUCKET_PR_ID` | required | Pull request ID. |
| `COPILOT_GITHUB_TOKEN` | primary; falls back to `GH_TOKEN` / `GITHUB_TOKEN` | Primary GitHub token for Copilot auth. |
| `GH_TOKEN` | used when `COPILOT_GITHUB_TOKEN` is unset | Fallback GitHub token for Copilot auth. |
| `GITHUB_TOKEN` | used when `COPILOT_GITHUB_TOKEN` and `GH_TOKEN` are unset | Fallback GitHub token for Copilot auth. |
| `BITBUCKET_TOKEN` | required unless basic auth vars are used | Bitbucket bearer token. |
| `BITBUCKET_USERNAME` | required with `BITBUCKET_PASSWORD` for basic auth | Bitbucket basic auth username. |
| `BITBUCKET_PASSWORD` | required with `BITBUCKET_USERNAME` for basic auth | Bitbucket basic auth password. |
| `REPO_ROOT` | current working directory | Path to the repository under review. |
| `GIT_REMOTE_NAME` | `origin` | Git remote name used to fetch PR commits. |
| `LOG_LEVEL` | `info` | Logger verbosity. |
| `BITBUCKET_AUTH_TYPE` | auto-detected from provided credentials | Bitbucket authentication strategy. |
| `BITBUCKET_CA_CERT_PATH` | - | PEM CA bundle path for Bitbucket TLS. |
| `BITBUCKET_INSECURE_TLS` | `true` | Skip strict TLS verification for Bitbucket. |
| `COPILOT_MODEL` | `gpt-5.4` | Copilot model override. |
| `COPILOT_REASONING_EFFORT` | `xhigh` | Copilot reasoning effort. |
| `COPILOT_TIMEOUT_MS` | `1800000` | Copilot timeout in milliseconds. |
| `CI_SUMMARY_PATH` | - | Path to a CI summary file included in review context. |
| `REPORT_KEY` | `copilot-pr-review` | Code Insights report key. |
| `REPORT_TITLE` | `Copilot PR Review` | Code Insights report title. |
| `REPORTER_NAME` | `GitHub Copilot via Jenkins` | Displayed report publisher name. |
| `REPORT_COMMENT_TAG` | `copilot-pr-review` | Tag used to locate the PR summary comment. |
| `REPORT_COMMENT_STRATEGY` | `recreate` | How the tagged PR summary comment is updated. |
| `REPORT_LINK` | falls back to `BUILD_URL` when present | Code Insights report link. |
| `BUILD_URL` | used when `REPORT_LINK` is unset | Fallback report link from CI build URL. |
| `REVIEW_FORCE` | `false` | Force review even when the revision was already published. |
| `REVIEW_MAX_FILES` | `200` | Maximum number of changed files to review. |
| `REVIEW_MAX_FINDINGS` | `25` | Maximum number of findings to publish. |
| `REVIEW_MIN_CONFIDENCE` | `medium` | Minimum confidence threshold for findings. |
| `REVIEW_MAX_PATCH_CHARS` | `12000` | Maximum diff size sent to Copilot per file. |
| `REVIEW_DEFAULT_FILE_SLICE_LINES` | `250` | Default line window when reading file slices. |
| `REVIEW_MAX_FILE_SLICE_LINES` | `400` | Maximum line window for file slices. |
| `REVIEW_IGNORE_PATHS` | [] | Comma-separated repo-relative glob patterns to skip. |
<!-- GENERATED_CONFIG_REFERENCE:END -->

## Install

```bash
corepack enable
pnpm install
pnpm typecheck
```

Note: `@github/copilot-sdk` currently needs a small pnpm patch in this repo to import `vscode-jsonrpc/node.js` correctly under Node ESM. The patch is tracked in `patches/@github__copilot-sdk@0.1.32.patch` and applied automatically by pnpm.

## Run locally

```bash
pnpm typecheck
node src/cli.ts --dry-run
```

## Test locally against a real repo and PR

The reviewer can run from this repo while reading git data from a different local checkout through `REPO_ROOT` or `--repo-root`.

Quickest option:

```bash
scripts/run-local-review.sh /path/to/local/my-repo \
  https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123
```

The script reads credentials from your environment, defaults to `gpt-5.4` with `xhigh` reasoning, and runs in dry-run mode unless you set `PUBLISH=1`.

If your Bitbucket Data Center uses an internal or self-signed certificate, prefer setting `BITBUCKET_CA_CERT_PATH` to a PEM file containing your corporate CA. Strict TLS verification is disabled by default. Set `BITBUCKET_INSECURE_TLS=0` after `BITBUCKET_CA_CERT_PATH` is configured if you want certificate validation enforced.

When the target repository contains a root-level `AGENTS.md`, the reviewer reads it and appends its instructions to the Copilot review prompt. Nested `AGENTS.md` files are not used.

When the target repository contains a root-level `copilot-code-review.json`, the reviewer loads it from the trusted base commit and uses it for repo-scoped review configuration such as ignored paths, review limits, and selected Copilot/report overrides. Environment variables and CLI flags still take precedence. The JSON schema is published at `schemas/copilot-code-review.schema.json`.

Example `copilot-code-review.json`:

```json
{
  "$schema": "./schemas/copilot-code-review.schema.json",
  "review": {
    "ignorePaths": ["i18n/locales/**/*.json"],
    "maxFiles": 200,
    "maxFindings": 25
  },
  "copilot": {
    "model": "gpt-5.4",
    "reasoningEffort": "xhigh"
  },
  "report": {
    "commentStrategy": "recreate"
  }
}
```

Example with common repo-specific customizations:

- `review.ignorePaths` skips noisy generated or localized assets such as locale bundles
- `copilot.model` pins a different model for this repository only
- `report.title` shortens the Bitbucket Code Insights title for this repo

```json
{
  "$schema": "./schemas/copilot-code-review.schema.json",
  "copilot": {
    "model": "gpt-5.4"
  },
  "report": {
    "title": "Copilot Review",
    "commentStrategy": "recreate"
  },
  "review": {
    "ignorePaths": [
      "i18n/locales/**/*.json",
      "docs/generated/**"
    ],
    "maxFiles": 200,
    "maxFindings": 25,
    "minConfidence": "medium",
    "maxPatchChars": 12000,
    "defaultFileSliceLines": 250,
    "maxFileSliceLines": 400
  }
}
```

By default, the reviewer computes a revision fingerprint from the effective PR diff (`merge-base -> source head`) and skips only when that exact PR revision already has a fully published result for the same `REPORT_KEY`. If the source head changes but the effective diff stays the same, the reviewer reuses the cached result and republishes it onto the new head without rerunning Copilot. If the target branch moves and changes the effective diff, the reviewer runs again. If the report exists but the published artifacts are missing or stale, the reviewer repairs them automatically. This revision-based format is a clean break from the old commit-only markers, so older artifacts are intentionally rerun once after rollout. Use `--force-review` or `REVIEW_FORCE=1` to force a rerun on the same revision.

Example PR URL:

```text
https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123
```

That maps to:

- `BITBUCKET_BASE_URL=https://bitbucket.example.com`
- `BITBUCKET_PROJECT_KEY=PROJ`
- `BITBUCKET_REPO_SLUG=my-repo`
- `BITBUCKET_PR_ID=123`

Recommended local test flow:

1. clone this reviewer repo and run `pnpm install && pnpm typecheck`
2. clone the target Bitbucket repo locally and make sure `git fetch origin` works there
3. export the environment variables below
4. run the reviewer in dry-run mode first

```bash
export REPO_ROOT="/path/to/local/my-repo"
export BITBUCKET_BASE_URL="https://bitbucket.example.com"
export BITBUCKET_PROJECT_KEY="PROJ"
export BITBUCKET_REPO_SLUG="my-repo"
export BITBUCKET_PR_ID="123"

export COPILOT_GITHUB_TOKEN="<github token with copilot access>"
export BITBUCKET_TOKEN="<bitbucket token>"
export COPILOT_MODEL="gpt-5.4"
export COPILOT_REASONING_EFFORT="xhigh"
export BITBUCKET_CA_CERT_PATH="/path/to/corporate-root-ca.pem"

export LOG_LEVEL="debug"
export REPORT_TITLE="Copilot PR Review (local dry run)"

node src/cli.ts --dry-run
```

Copilot reasoning is always written through the logger to `stderr`, while the final review payload is always printed as JSON on `stdout`.

If you want to include local CI context in the review:

```bash
printf 'Unit tests passed\nLint passed\n' > /tmp/ci-summary.txt
export CI_SUMMARY_PATH="/tmp/ci-summary.txt"
node src/cli.ts --dry-run
```

If you want the local run to publish to the Bitbucket PR page, remove `--dry-run` and use a unique report key so you do not overwrite the Jenkins report. Bitbucket Data Center limits report keys to 50 characters, and the reviewer still sanitizes and shortens overrides when needed:

```bash
export REPORT_KEY="copilot-local-$USER"
export REPORT_TITLE="Copilot PR Review (local)"
export REPORTER_NAME="GitHub Copilot Local Test"

node src/cli.ts
```

What to expect:

- `--dry-run` prints the report and annotations JSON to stdout and does not modify Bitbucket
- without `--dry-run`, the script publishes a Code Insights report and annotations to the PR's latest source commit
- if the PR head changed while you were testing, the script skips publish to avoid posting stale results

Common local test issues:

- the repo in `REPO_ROOT` is not the same repo as `BITBUCKET_PROJECT_KEY` and `BITBUCKET_REPO_SLUG`
- the local checkout cannot fetch the source or target commit referenced by the PR
- `copilot` CLI is not installed or authenticated
- Node.js does not trust the Bitbucket TLS certificate chain; use `BITBUCKET_CA_CERT_PATH`, or keep the default `BITBUCKET_INSECURE_TLS=1` until trust is configured
- the PR is from a fork and your local git credentials cannot fetch the fork remote URL returned by Bitbucket

## Jenkins usage

See `Jenkinsfile.example` for a Declarative Pipeline example that uses:

```groovy
agent { label "DK_UBCOMMON2404" }
```

Suggested pipeline flow:

1. run your normal checkout, lint, test, and build stages first
2. write a compact CI summary to `CI_SUMMARY_PATH`
3. invoke `node src/cli.ts` in the PR workspace

Important Jenkins assumptions:

- the Jenkins workspace is the repository root, or set `REPO_ROOT`
- the PR source and target commits are fetchable from the workspace remotes
- the `copilot` CLI is preinstalled on the agent

Useful reviewer env vars in Jenkins:

- `REPO_ROOT=${WORKSPACE}`
- `REPORT_LINK=${BUILD_URL}`
- `REPORTER_NAME=GitHub Copilot via Jenkins`
- `COPILOT_TIMEOUT_MS=1800000`
- `REVIEW_MAX_FINDINGS=25`
- `REVIEW_MAX_FILES=200`
- `REVIEW_IGNORE_PATHS=i18n/locales/**/*.json`

For a safe first rollout, start with `--dry-run`, inspect the payload in Jenkins logs, then remove `--dry-run` once the Code Insights output looks right.

## Notes

- The reviewer intentionally blocks Copilot from using general shell or edit tools in CI.
- Only annotations that land on changed lines are published.
- The reviewer also upserts one tagged pull-request summary comment by default.
- For reruns, the script replaces the prior report for the same report key.

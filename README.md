# Bitbucket Copilot PR Review

Automated Bitbucket Data Center pull request review for Jenkins, powered by the GitHub Copilot SDK.

## What it does

- reads PR metadata from Bitbucket Data Center
- computes the PR diff locally from the Jenkins workspace
- asks Copilot to review only the changed PR scope through read-only custom tools
- publishes the result as Bitbucket Code Insights reports and annotations

## Runtime requirements

- Node.js 24.12+
- pnpm 10+
- `@github/copilot` is installed with this package so the reviewer can resolve and launch the bundled Copilot CLI runtime from `node_modules`
- a GitHub Copilot-enabled account for CI

## Required credentials

- `BITBUCKET_TOKEN` for Bitbucket Data Center REST API access

Copilot authentication is resolved by the GitHub Copilot SDK. You can rely on an existing `copilot` CLI login, `gh auth` credentials, or any supported GitHub token environment variable that the SDK already knows how to read. See the official SDK auth docs: <https://github.com/github/copilot-sdk/blob/main/docs/auth/index.md>.

If your Bitbucket environment requires basic auth instead of bearer tokens, provide `BITBUCKET_USERNAME` and `BITBUCKET_PASSWORD` and set `BITBUCKET_AUTH_TYPE=basic`.

<!-- GENERATED_CONFIG_REFERENCE:START -->

## Configuration Reference

### CLI options

| Option                      | Description                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `--dry-run`, `--no-publish` | Run the review but skip Bitbucket publishing                                                        |
| `--force-review`            | Run even if the current PR revision already has a fully published result                            |
| `--confirm-rerun`           | Prompt only when rerunning unusable cached artifacts for the current unchanged PR head and revision |
| `--repo-root <path>`        | Path to the repository under review                                                                 |
| `--repo-id <project/repo>`  | Review all open PRs for the given Bitbucket project/repo                                            |
| `--temp-root <path>`        | Parent directory for temporary batch review clones                                                  |
| `--max-parallel <count>`    | Maximum concurrent PR review subprocesses in batch mode                                             |
| `--keep-workdirs`           | Keep temporary batch review clones after the run completes                                          |
| `-h`, `--help`              | Show this help text                                                                                 |

### Environment variables

| Variable                          | Default                                           | Description                                                    |
| --------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| `BITBUCKET_BASE_URL`              | required                                          | Bitbucket Data Center base URL.                                |
| `BITBUCKET_PROJECT_KEY`           | required                                          | Bitbucket project key.                                         |
| `BITBUCKET_REPO_SLUG`             | required                                          | Bitbucket repository slug.                                     |
| `BITBUCKET_PR_ID`                 | required                                          | Pull request ID.                                               |
| `BITBUCKET_TOKEN`                 | required unless basic auth vars are used          | Bitbucket bearer token.                                        |
| `BITBUCKET_USERNAME`              | required with `BITBUCKET_PASSWORD` for basic auth | Bitbucket basic auth username.                                 |
| `BITBUCKET_PASSWORD`              | required with `BITBUCKET_USERNAME` for basic auth | Bitbucket basic auth password.                                 |
| `REPO_ROOT`                       | current working directory                         | Path to the repository under review.                           |
| `GIT_REMOTE_NAME`                 | `origin`                                          | Git remote name used to fetch PR commits.                      |
| `LOG_LEVEL`                       | `info`                                            | Logger verbosity.                                              |
| `BITBUCKET_AUTH_TYPE`             | auto-detected from provided credentials           | Bitbucket authentication strategy.                             |
| `BITBUCKET_CA_CERT_PATH`          | -                                                 | PEM CA bundle path for Bitbucket TLS.                          |
| `BITBUCKET_INSECURE_TLS`          | `true`                                            | Skip strict TLS verification for Bitbucket.                    |
| `COPILOT_MODEL`                   | `gpt-5.4`                                         | Copilot model override.                                        |
| `COPILOT_REASONING_EFFORT`        | `xhigh`                                           | Copilot reasoning effort.                                      |
| `COPILOT_TIMEOUT_MS`              | `1800000`                                         | Copilot timeout in milliseconds.                               |
| `CI_SUMMARY_PATH`                 | -                                                 | Path to a CI summary file included in review context.          |
| `REPORT_KEY`                      | `copilot-pr-review`                               | Code Insights report key.                                      |
| `REPORT_TITLE`                    | `Copilot PR Review`                               | Code Insights report title.                                    |
| `REPORTER_NAME`                   | `GitHub Copilot via Jenkins`                      | Displayed report publisher name.                               |
| `REPORT_COMMENT_TAG`              | `copilot-pr-review`                               | Tag used to locate the PR summary comment.                     |
| `REPORT_COMMENT_STRATEGY`         | `recreate`                                        | How the tagged PR summary comment is updated.                  |
| `REPORT_LINK`                     | falls back to `BUILD_URL` when present            | Code Insights report link.                                     |
| `BUILD_URL`                       | used when `REPORT_LINK` is unset                  | Fallback report link from CI build URL.                        |
| `REVIEW_FORCE`                    | `false`                                           | Force review even when the revision was already published.     |
| `REVIEW_MAX_FILES`                | `300`                                             | Maximum number of changed files to review.                     |
| `REVIEW_MAX_FINDINGS`             | `25`                                              | Maximum number of findings to publish.                         |
| `REVIEW_MIN_CONFIDENCE`           | `medium`                                          | Minimum confidence threshold for findings.                     |
| `REVIEW_MAX_PATCH_CHARS`          | `12000`                                           | Maximum diff size sent to Copilot per file.                    |
| `REVIEW_DEFAULT_FILE_SLICE_LINES` | `250`                                             | Default line window when reading file slices.                  |
| `REVIEW_MAX_FILE_SLICE_LINES`     | `400`                                             | Maximum line window for file slices.                           |
| `REVIEW_IGNORE_PATHS`             | []                                                | Comma-separated repo-relative glob patterns to skip.           |
| `REVIEW_SKIP_BRANCH_PREFIXES`     | `renovate/`                                       | Comma-separated source branch prefixes that should be skipped. |

### Batch review mode

Use `--repo-id <project/repo>` to clone the repository into a temp working area, list open PRs, and fan out one subprocess review per PR.

<!-- GENERATED_CONFIG_REFERENCE:END -->

## Install

```bash
corepack enable
pnpm install
pnpm build
pnpm typecheck
```

Note: `@github/copilot-sdk` currently needs a small pnpm patch in this repo to import `vscode-jsonrpc/node.js` correctly under Node ESM. The patch is tracked in `patches/@github__copilot-sdk@0.1.32.patch` and applied automatically by pnpm.

## CLI package

The project now builds a distributable CLI with `tsdown` into `dist/cli.js`.

```bash
pnpm build
node dist/cli.js --help
```

After publishing, the package can be invoked with `npx`:

```bash
NODE_USE_SYSTEM_CA=1 npx bitbucket-copilot-pr-review --help
```

When invoking the published CLI directly with `npx`, pass `NODE_USE_SYSTEM_CA=1` yourself if you want Node to trust your system CA store.

## Run locally

```bash
pnpm typecheck
pnpm review:dry-run
```

## Review all open PRs in a repo

Use batch mode when you want the tool to clone a Bitbucket repository into a temp working area, discover all open pull requests, and spawn one isolated review subprocess per PR.

Quickest option:

```bash
scripts/run-local-batch-review.sh AAAS/sbp
```

Or run the CLI directly:

```bash
export BITBUCKET_BASE_URL="https://bitbucket.example.com"
export BITBUCKET_TOKEN="<bitbucket token>"

NODE_USE_SYSTEM_CA=1 node dist/cli.js --repo-id AAAS/sbp --dry-run --max-parallel 2
```

Batch mode keeps a shared bare mirror cache under the temp root and creates one disposable workspace per PR from that cache. Use `--temp-root` to choose the parent directory or `--keep-workdirs` to preserve the per-PR clones for debugging.

The batch JSON output now includes `metrics.mirror` and `metrics.workspaces` so you can inspect mirror refresh timing, lock wait time, workspace provisioning totals, cleanup totals, and whether the run root was retained.

The helper script reads credentials from your environment, defaults to `gpt-5.4` with `xhigh` reasoning, enables `NODE_USE_SYSTEM_CA=1` unless you override it, runs in dry-run mode unless you set `PUBLISH=1`, and forwards common batch-mode controls such as `MAX_PARALLEL`, `TEMP_ROOT`, `KEEP_WORKDIRS=1`, and `FORCE_REVIEW=1`.

Pull requests whose source branch starts with `renovate/` are always skipped automatically.

You can override the skipped branch prefixes with `REVIEW_SKIP_BRANCH_PREFIXES` or repo-level `review.skipBranchPrefixes`; the default remains `["renovate/"]`.

## Test locally against a real repo and PR

The reviewer can run from this repo while reading git data from a different local checkout through `REPO_ROOT` or `--repo-root`.

Quickest option:

```bash
scripts/run-local-review.sh /path/to/local/my-repo \
  https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123
```

The script reads credentials from your environment, defaults to `gpt-5.4` with `xhigh` reasoning, enables `NODE_USE_SYSTEM_CA=1` unless you override it, and runs in dry-run mode unless you set `PUBLISH=1`.

If your Bitbucket Data Center uses an internal or self-signed certificate, prefer setting `BITBUCKET_CA_CERT_PATH` to a PEM file containing your corporate CA. Strict TLS verification is disabled by default. Set `BITBUCKET_INSECURE_TLS=0` after `BITBUCKET_CA_CERT_PATH` is configured if you want certificate validation enforced.

For local helper-script runs, Node system CA loading is enabled by default with `NODE_USE_SYSTEM_CA=1`. Set `NODE_USE_SYSTEM_CA=0` if you need to disable that behavior for troubleshooting or environment-specific differences.

When the target repository contains a root-level `AGENTS.md`, the reviewer reads it and appends its instructions to the Copilot review prompt. Nested `AGENTS.md` files are not used.

When the target repository contains a root-level `copilot-code-review.json`, the reviewer loads it from the trusted base commit and uses it for repo-scoped review configuration such as ignored paths, review limits, and selected Copilot/report overrides. Environment variables and CLI flags still take precedence. The JSON schema is published at `schemas/copilot-code-review.schema.json`.

By default, the reviewer inspects up to 300 changed files after filtering. When more than 25 files remain in scope, it still runs the review but skips per-file changed-file summaries in the tagged PR comment.

Example `copilot-code-review.json`:

```json
{
  "$schema": "./schemas/copilot-code-review.schema.json",
  "review": {
    "ignorePaths": ["i18n/locales/**/*.json"],
    "maxFiles": 300,
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
    "ignorePaths": ["i18n/locales/**/*.json", "docs/generated/**"],
    "maxFiles": 300,
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

export BITBUCKET_TOKEN="<bitbucket token>"
export COPILOT_MODEL="gpt-5.4"
export COPILOT_REASONING_EFFORT="xhigh"
export BITBUCKET_CA_CERT_PATH="/path/to/corporate-root-ca.pem"

export LOG_LEVEL="debug"
export REPORT_TITLE="Copilot PR Review (local dry run)"

pnpm review:dry-run
```

Copilot reasoning is always written through the logger to `stderr`, while the final review payload is always printed as JSON on `stdout`.

If you want to include local CI context in the review:

```bash
printf 'Unit tests passed\nLint passed\n' > /tmp/ci-summary.txt
export CI_SUMMARY_PATH="/tmp/ci-summary.txt"
pnpm review:dry-run
```

If you want the local run to publish to the Bitbucket PR page, remove `--dry-run` and use a unique report key so you do not overwrite the Jenkins report. Bitbucket Data Center limits report keys to 50 characters, and the reviewer still sanitizes and shortens overrides when needed:

```bash
export REPORT_KEY="copilot-local-$USER"
export REPORT_TITLE="Copilot PR Review (local)"
export REPORTER_NAME="GitHub Copilot Local Test"

pnpm review
```

What to expect:

- `--dry-run` prints the report and annotations JSON to stdout and does not modify Bitbucket
- without `--dry-run`, the script publishes a Code Insights report and annotations to the PR's latest source commit
- if the PR head changed while you were testing, the script skips publish to avoid posting stale results

Common local test issues:

- the repo in `REPO_ROOT` is not the same repo as `BITBUCKET_PROJECT_KEY` and `BITBUCKET_REPO_SLUG`
- the local checkout cannot fetch the source or target commit referenced by the PR
- the bundled `@github/copilot` runtime is missing or the Copilot SDK cannot resolve auth from your existing login or token setup
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
3. invoke `node dist/cli.js` in the PR workspace, or `pnpm review`

Important Jenkins assumptions:

- the Jenkins workspace is the repository root, or set `REPO_ROOT`
- the PR source and target commits are fetchable from the workspace remotes
- `pnpm install` has been run so the bundled `@github/copilot` runtime is available to the reviewer

Useful reviewer env vars in Jenkins:

- `REPO_ROOT=${WORKSPACE}`
- `REPORT_LINK=${BUILD_URL}`
- `REPORTER_NAME=GitHub Copilot via Jenkins`
- `COPILOT_TIMEOUT_MS=1800000`
- `REVIEW_MAX_FINDINGS=25`
- `REVIEW_MAX_FILES=300`
- `REVIEW_IGNORE_PATHS=i18n/locales/**/*.json`

For a safe first rollout, start with `--dry-run`, inspect the payload in Jenkins logs, then remove `--dry-run` once the Code Insights output looks right.

## Notes

- The reviewer intentionally blocks Copilot from using general shell or edit tools in CI.
- Only annotations that land on changed lines are published.
- The reviewer also upserts one tagged pull-request summary comment by default.
- For reruns, the script replaces the prior report for the same report key.

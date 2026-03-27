# Operations Guide

This guide collects the implementation and operator detail that is intentionally kept out of the main `README.md`.

## Runtime Requirements

- Node.js 24.12+
- pnpm 10+
- `@github/copilot` is installed with this package so the reviewer can resolve and launch the bundled Copilot CLI runtime from `node_modules`
- a GitHub Copilot-enabled account

## Authentication

- `BITBUCKET_TOKEN` is the default Bitbucket Data Center credential
- if your Bitbucket environment requires basic auth, set `BITBUCKET_USERNAME`, `BITBUCKET_PASSWORD`, and `BITBUCKET_AUTH_TYPE=basic`
- Copilot authentication is resolved by the GitHub Copilot SDK; you can rely on an existing `copilot` CLI login, `gh auth` credentials, or any supported GitHub token environment variable already understood by the SDK

Official Copilot SDK auth docs: <https://github.com/github/copilot-sdk/blob/main/docs/auth/index.md>

`REPO_ROOT` is optional for single-PR review. If you run the CLI from the target repository root, the current working directory is used automatically. Set `REPO_ROOT` or pass `--repo-root` only when the local checkout you want to review lives somewhere else. Batch mode does not use `REPO_ROOT`; it provisions its own temp clones.

## Configuration Model

The runtime resolves settings in this order:

| Priority | Source | Notes |
| --- | --- | --- |
| 1 | CLI flags and command arguments | Highest priority for the current invocation. |
| 2 | Environment variables | Best for CI systems and other automation. |
| 3 | Trusted repo config | Loaded from `copilot-code-review.json` at the PR base commit. |
| 4 | Built-in defaults | Used only when nothing else overrides the setting. |

Trusted repo config stays intentionally narrow: repository-level JSON can tune review behavior, but it cannot replace command arguments or runtime-only connection details.

Setting sources at a glance:

| Setting area | CLI | Environment | Trusted repo config |
| --- | --- | --- | --- |
| PR URL / repository URL | required positional arg | - | - |
| `repoRoot` | `--repo-root` | `REPO_ROOT` | - |
| batch workspace controls | `--temp-root`, `--max-parallel`, `--keep-workdirs` | - | - |
| Bitbucket auth and TLS | - | yes | - |
| Copilot model / reasoning / timeout | - | yes | yes |
| report title / comment strategy | - | yes | yes |
| review limits / ignore paths / skip prefixes | `--dry-run`, `--force-review`, `--confirm-rerun` | yes | yes |

<!-- GENERATED_CONFIG_REFERENCE:START -->
## Configuration Reference

### Review command

Review one pull request from an explicit Bitbucket URL

Usage: `bitbucket-copilot-pr-review review <pull-request-url> [options]`

| Option | Description |
| --- | --- |
| `--dry-run` | Run without publishing results to Bitbucket |
| `--force-review` | Re-run even if the current PR revision already has published results |
| `--confirm-rerun` | Ask before rerunning unusable cached artifacts for an unchanged PR revision |
| `--repo-root <path>` | Use a different local checkout as the repository root |
| `-h`, `--help` | Show this help text |

Argument: `<pull-request-url>`

Bitbucket pull request URL, for example https://host/projects/PROJ/repos/repo/pull-requests/123.

### Batch command

Review all open pull requests for one Bitbucket repository URL

Usage: `bitbucket-copilot-pr-review batch <repository-url> [options]`

| Option | Description |
| --- | --- |
| `--dry-run` | Run without publishing results to Bitbucket |
| `--force-review` | Re-run even if the current PR revision already has published results |
| `--temp-root <path>` | Parent directory for mirror and workspace clones |
| `--max-parallel <count>` | Maximum concurrent review workers |
| `--keep-workdirs` | Keep per-PR workdirs after the run completes |
| `-h`, `--help` | Show this help text |

Argument: `<repository-url>`

Bitbucket repository URL, for example https://host/projects/PROJ/repos/my-repo.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `BITBUCKET_TOKEN` | required unless basic auth vars are used | Bitbucket bearer token. |
| `BITBUCKET_USERNAME` | required with `BITBUCKET_PASSWORD` for basic auth | Bitbucket basic auth username. |
| `BITBUCKET_PASSWORD` | required with `BITBUCKET_USERNAME` for basic auth | Bitbucket basic auth password. |
| `REPO_ROOT` | current working directory | Path to the repository under review. |
| `GIT_REMOTE_NAME` | `origin` | Git remote name used to fetch PR commits. |
| `LOG_LEVEL` | `info` | Logger verbosity. |
| `BITBUCKET_AUTH_TYPE` | auto-detected from provided credentials | Bitbucket authentication strategy. |
| `BITBUCKET_CA_CERT_PATH` | - | PEM CA bundle path for Bitbucket TLS. |
| `BITBUCKET_INSECURE_TLS` | `false` | Skip strict TLS verification for Bitbucket. |
| `COPILOT_MODEL` | `gpt-5.4` | Copilot model override. |
| `COPILOT_REASONING_EFFORT` | `xhigh` | Copilot reasoning effort. |
| `COPILOT_TIMEOUT_MS` | `1800000` | Copilot timeout in milliseconds. |
| `CI_SUMMARY_PATH` | - | Path to a CI summary file included in review context. |
| `REPORT_KEY` | `copilot-pr-review` | Code Insights report key. |
| `REPORT_TITLE` | `Copilot PR Review` | Code Insights report title. |
| `REPORTER_NAME` | `GitHub Copilot` | Displayed report publisher name. |
| `REPORT_COMMENT_TAG` | `copilot-pr-review` | Tag used to locate the PR summary comment. |
| `REPORT_COMMENT_STRATEGY` | `recreate` | How the tagged PR summary comment is updated. |
| `REPORT_LINK` | falls back to `BUILD_URL` when present | Code Insights report link. |
| `BUILD_URL` | used when `REPORT_LINK` is unset | Fallback report link from CI build URL. |
| `REVIEW_FORCE` | `false` | Force review even when the revision was already published. |
| `REVIEW_MAX_FILES` | `300` | Maximum number of changed files to review. |
| `REVIEW_MAX_FINDINGS` | `25` | Maximum number of findings to publish. |
| `REVIEW_MIN_CONFIDENCE` | `medium` | Minimum confidence threshold for findings. |
| `REVIEW_MAX_PATCH_CHARS` | `12000` | Maximum diff size sent to Copilot per file. |
| `REVIEW_DEFAULT_FILE_SLICE_LINES` | `250` | Default line window when reading file slices. |
| `REVIEW_MAX_FILE_SLICE_LINES` | `400` | Maximum line window for file slices. |
| `REVIEW_IGNORE_PATHS` | [] | Comma-separated repo-relative glob patterns to skip. |
| `REVIEW_SKIP_BRANCH_PREFIXES` | `renovate/` | Comma-separated source branch prefixes that should be skipped. |

<!-- GENERATED_CONFIG_REFERENCE:END -->

## Published CLI

After publishing to npm, you can run the tool without cloning this repository:

```bash
export BITBUCKET_TOKEN="<bitbucket token>"
export REPO_ROOT="/path/to/local/my-repo"

NODE_USE_SYSTEM_CA=1 npx bitbucket-copilot-pr-review review \
  https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123 \
  --dry-run
```

For batch review:

```bash
export BITBUCKET_TOKEN="<bitbucket token>"

NODE_USE_SYSTEM_CA=1 npx bitbucket-copilot-pr-review batch \
  https://bitbucket.example.com/projects/PROJ/repos/my-repo \
  --dry-run \
  --max-parallel 2
```

If your environment needs access to a custom CA bundle, keep using `NODE_USE_SYSTEM_CA=1` or set `BITBUCKET_CA_CERT_PATH`.

## Single Pull Request Review

Dry-run one pull request:

```bash
pnpm review:dry-run -- https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123
```

Publish once the dry-run output looks correct:

```bash
pnpm review -- https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123
```

## Batch Review

Batch mode clones a Bitbucket repository into a temp working area, discovers open pull requests, and spawns one isolated review subprocess per PR.

Quickest option:

```bash
scripts/run-local-batch-review.sh \
  https://bitbucket.example.com/projects/PROJ/repos/my-repo
```

Or run the CLI directly:

```bash
export BITBUCKET_TOKEN="<bitbucket token>"

NODE_USE_SYSTEM_CA=1 node dist/cli.js batch https://bitbucket.example.com/projects/PROJ/repos/my-repo --dry-run --max-parallel 2
```

Batch mode keeps a shared bare mirror cache under the temp root and creates one disposable workspace per PR from that cache. Use `--temp-root` to choose the parent directory or `--keep-workdirs` to preserve per-PR clones for debugging.

The batch JSON output includes `metrics.mirror` and `metrics.workspaces`. Single-review JSON output includes `metrics.toolTelemetry` so you can inspect which Copilot tools were requested, allowed, denied, and completed.

The helper script reads credentials from your environment, defaults to `gpt-5.4` with `xhigh` reasoning, enables `NODE_USE_SYSTEM_CA=1` unless you override it, runs in dry-run mode unless you set `PUBLISH=1`, and forwards common controls such as `MAX_PARALLEL`, `TEMP_ROOT`, `KEEP_WORKDIRS=1`, and `FORCE_REVIEW=1`.

Pull requests whose source branch starts with `renovate/` are skipped automatically. You can override the skipped branch prefixes with `REVIEW_SKIP_BRANCH_PREFIXES` or repo-level `review.skipBranchPrefixes`; the default remains `["renovate/"]`.

## Testing Against a Real Repo and PR

The reviewer can run from this repo while reading git data from a different local checkout through `REPO_ROOT` or `--repo-root`.

Quickest option:

```bash
scripts/run-local-review.sh /path/to/local/my-repo \
  https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123
```

The helper script reads credentials from your environment, defaults to `gpt-5.4` with `xhigh` reasoning, enables `NODE_USE_SYSTEM_CA=1` unless you override it, and runs in dry-run mode unless you set `PUBLISH=1`.

If your Bitbucket Data Center uses an internal or self-signed certificate, prefer setting `BITBUCKET_CA_CERT_PATH` to a PEM file containing your CA bundle. Strict TLS verification is enabled by default. Set `BITBUCKET_INSECURE_TLS=1` only as a temporary workaround if you need to bypass certificate validation while trust is being configured.

For local helper-script runs, Node system CA loading is enabled by default with `NODE_USE_SYSTEM_CA=1`. Set `NODE_USE_SYSTEM_CA=0` if you need to disable that behavior for troubleshooting.

When the target repository contains `AGENTS.md` files in the root or in directories that contain reviewed files, the reviewer reads the matching files from the trusted base commit and appends them to the Copilot review prompt. Root instructions apply repo-wide, and deeper `AGENTS.md` files apply only to reviewed files under that subtree.

When the target repository contains a root-level `copilot-code-review.json`, the reviewer loads it from the trusted base commit and uses it for repo-scoped review configuration such as ignored paths, review limits, and selected Copilot or report overrides. Environment variables and CLI flags still take precedence. The JSON schema is published at `schemas/copilot-code-review.schema.json`.

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

- `review.ignorePaths` skips noisy generated or localized assets
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

By default, the reviewer computes a revision fingerprint from the effective PR diff (`merge-base -> source head`) and skips only when that exact PR revision already has a fully published result for the same `REPORT_KEY`. If the source head changes but the effective diff stays the same, the reviewer reuses the cached result and republishes it onto the new head without rerunning Copilot. If the target branch moves and changes the effective diff, the reviewer runs again. If the report exists but the published artifacts are missing or stale, the reviewer repairs them automatically. Use `--force-review` or `REVIEW_FORCE=1` to force a rerun on the same revision.

Recommended local test flow:

1. clone this reviewer repo and run `pnpm install && pnpm typecheck`
2. clone the target Bitbucket repo locally and make sure `git fetch origin` works there
3. export the environment variables below
4. run the reviewer in dry-run mode first

```bash
export REPO_ROOT="/path/to/local/my-repo"
export BITBUCKET_TOKEN="<bitbucket token>"
export COPILOT_MODEL="gpt-5.4"
export COPILOT_REASONING_EFFORT="xhigh"
export BITBUCKET_CA_CERT_PATH="/path/to/root-ca.pem"

export LOG_LEVEL="debug"
export REPORT_TITLE="Copilot PR Review (local dry run)"

pnpm review:dry-run -- https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123
```

Copilot reasoning is written through the logger to `stderr`, while the final review payload is printed as JSON on `stdout`.

If you want to include local build or CI context in the review:

```bash
printf 'Unit tests passed\nLint passed\n' > /tmp/ci-summary.txt
export CI_SUMMARY_PATH="/tmp/ci-summary.txt"
pnpm review:dry-run -- https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123
```

If you want the local run to publish to the Bitbucket PR page, drop the trailing `--dry-run` and use a unique report key so you do not overwrite your normal automated report. Bitbucket Data Center limits report keys to 50 characters, and the reviewer still sanitizes and shortens overrides when needed:

```bash
export REPORT_KEY="copilot-local-$USER"
export REPORT_TITLE="Copilot PR Review (local)"
export REPORTER_NAME="GitHub Copilot Local Test"

pnpm review -- https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123
```

What to expect:

- `--dry-run` prints the report and annotations JSON to stdout and does not modify Bitbucket
- without `--dry-run`, the script publishes a Code Insights report and annotations to the PR's latest source commit
- if the PR head changed while you were testing, the script skips publish to avoid posting stale results

Common local test issues:

- the repo in `REPO_ROOT` is not the same repo referenced by the PR URL
- the local checkout cannot fetch the source or target commit referenced by the PR
- the bundled `@github/copilot` runtime is missing or the Copilot SDK cannot resolve auth from your existing login or token setup
- Node.js does not trust the Bitbucket TLS certificate chain; use `BITBUCKET_CA_CERT_PATH`, or set `BITBUCKET_INSECURE_TLS=1` temporarily until trust is configured
- the PR is from a fork and your local git credentials cannot fetch the fork remote URL returned by Bitbucket

## CI Usage

Suggested CI flow:

1. run your normal checkout, lint, test, and build stages first
2. write a compact CI summary to `CI_SUMMARY_PATH`
3. invoke `node dist/cli.js review <pull-request-url>` in the PR workspace, or `pnpm review -- <pull-request-url>`

Typical CI assumptions:

- the current working directory is the repository root, or set `REPO_ROOT`
- the PR source and target commits are fetchable from the checked-out remotes
- `pnpm install` has been run so the bundled `@github/copilot` runtime is available to the reviewer

Useful reviewer env vars in CI:

- `REPO_ROOT="$PWD"`
- `REPORT_LINK="<build or job URL>"`
- `REPORTER_NAME=GitHub Copilot`
- `COPILOT_TIMEOUT_MS=1800000`
- `REVIEW_MAX_FINDINGS=25`
- `REVIEW_MAX_FILES=300`
- `REVIEW_IGNORE_PATHS=i18n/locales/**/*.json`

For a safe first rollout, start with `--dry-run`, inspect the payload in your CI logs, then remove `--dry-run` once the Code Insights output looks right.

## Release and Publishing

Run `pnpm release:check` before publishing or cutting a release. It runs formatting or lint checks, typecheck, tests, a production build, built CLI help smoke tests, and `npm pack --dry-run`, then verifies that the packed tarball includes `dist/cli.js`, `README.md`, and `schemas/copilot-code-review.schema.json`.

GitHub Actions publishing is defined in `.github/workflows/publish.yml` and uses npm trusted publishing with GitHub OIDC instead of an `NPM_TOKEN` secret.

Before the workflow can publish, configure the package's trusted publisher on npmjs.com to match this repository:

- provider: GitHub Actions
- owner: `guitaoliu`
- repository: `bitbucket-copilot-pr-review`
- workflow filename: `publish.yml`

After that, bump `package.json`, create a tag like `v0.1.1`, and push the tag to GitHub. The workflow installs dependencies with pnpm, runs `pnpm release:check`, generates the GitHub release notes with `npx changelogithub`, and publishes with `npm publish` on a GitHub-hosted runner using OIDC.

## Notes

- the reviewer intentionally blocks Copilot from using general shell or edit tools during automated review runs
- only annotations that land on changed lines are published
- the reviewer also upserts one tagged pull-request summary comment by default
- for reruns, the script replaces the prior report for the same report key

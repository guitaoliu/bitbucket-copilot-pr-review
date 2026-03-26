# Bitbucket Copilot PR Review

CLI-first pull request review automation for Bitbucket Data Center, powered by the GitHub Copilot SDK.

This project computes a PR diff locally, gives Copilot a tightly scoped read-only view of the changed code, and publishes the result back to Bitbucket as Code Insights reports, annotations, and one tagged summary comment.

## Highlights

- reviews only the changed pull request scope
- runs from your local checkout or CI workspace instead of shipping repository contents to a separate service
- publishes native Bitbucket review artifacts
- supports single-PR and batch repository review flows
- loads trusted repo-level configuration from the PR base commit

## Requirements

- Node.js 24.12+
- pnpm 10+
- Bitbucket Data Center API access
- a GitHub Copilot-enabled account

## Authentication

- Bitbucket: set `BITBUCKET_TOKEN`, or use `BITBUCKET_USERNAME` and `BITBUCKET_PASSWORD` with `BITBUCKET_AUTH_TYPE=basic`
- GitHub Copilot: this CLI relies on the GitHub Copilot SDK, which uses existing GitHub or Copilot authentication already available in your environment

In practice, that usually means one of these is already set up before you run the tool:

- an existing `gh auth` login
- an existing Copilot CLI login
- a supported GitHub token environment variable recognized by the Copilot SDK

See `docs/operations.md` for the operator-focused details and the upstream SDK auth reference.

## Use With npx

Run the CLI with `npx` from the same local repository checkout that the pull request points to:

```bash
export BITBUCKET_TOKEN="<bitbucket token>"

NODE_USE_SYSTEM_CA=1 npx bitbucket-copilot-pr-review review \
  https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123 \
  --dry-run
```

The `review` command reads local git data from your current working directory by default, so run it from the target repository root. Set `REPO_ROOT` or `--repo-root` only when the repository being reviewed lives somewhere else. Batch mode does not need `REPO_ROOT` because it clones the repository into its own temp workspace.

When the dry run looks correct, rerun without `--dry-run` to publish the Bitbucket review artifacts.

Batch mode works the same way with the published CLI:

```bash
export BITBUCKET_TOKEN="<bitbucket token>"

NODE_USE_SYSTEM_CA=1 npx bitbucket-copilot-pr-review batch \
  https://bitbucket.example.com/projects/PROJ/repos/my-repo \
  --dry-run \
  --max-parallel 2
```

## Quick Start From Source

1. Install dependencies and build the CLI locally:

   ```bash
   corepack enable
   pnpm install
   pnpm build
   ```

2. Export Bitbucket auth and, when needed, point the reviewer at a local checkout:

   ```bash
   export BITBUCKET_TOKEN="<bitbucket token>"
   export REPO_ROOT="/path/to/local/my-repo"
   ```

3. Dry-run one pull request first:

   ```bash
   pnpm review:dry-run -- https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123
   ```

4. Publish once the output looks correct:

   ```bash
   pnpm review -- https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123
   ```

Use `pnpm review --help` or `pnpm batch --help` for command-specific help while developing locally.

## How It Works

- reads pull request metadata from Bitbucket Data Center
- computes the effective PR diff from local git data
- asks Copilot to inspect only the changed review scope through read-only tools
- validates findings against changed lines before publication
- publishes a Bitbucket Code Insights report, annotations, and a tagged PR comment

## Repo Config Example

If the target repository contains a root-level `copilot-code-review.json`, the reviewer loads it from the trusted base commit and uses it as repo-scoped configuration. The schema lives at `schemas/copilot-code-review.schema.json`.

Minimal example:

```json
{
  "$schema": "./schemas/copilot-code-review.schema.json",
  "review": {
    "ignorePaths": ["i18n/locales/**/*.json"],
    "maxFiles": 300,
    "maxFindings": 25
  }
}
```

Expanded example:

```json
{
  "$schema": "./schemas/copilot-code-review.schema.json",
  "copilot": {
    "model": "gpt-5.4",
    "reasoningEffort": "xhigh"
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
    "maxFileSliceLines": 400,
    "skipBranchPrefixes": ["renovate/", "deps/"]
  }
}
```

## CLI Usage

Published package:

```bash
NODE_USE_SYSTEM_CA=1 npx bitbucket-copilot-pr-review review --help
```

```bash
NODE_USE_SYSTEM_CA=1 npx bitbucket-copilot-pr-review batch --help
```

Local source checkout:

```bash
pnpm build
node dist/cli.js review --help
```

## Documentation

- `docs/operations.md` - configuration, local testing, CI usage, batch mode, release verification, and npm publishing
- `schemas/copilot-code-review.schema.json` - JSON schema for trusted repo config

## Why This Exists

Bitbucket Data Center teams often want Copilot-assisted review inside their existing development and CI workflows. This project keeps the review loop inside your own Bitbucket and execution environment while staying conservative about file access, changed-line validation, and publication behavior.

## License

This project is licensed under Apache-2.0.

It depends on `@github/copilot`, which is distributed under GitHub's separate license terms. Those terms apply to that runtime and GitHub Copilot service access; Apache-2.0 applies to this repository's source code.

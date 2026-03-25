# Bitbucket Copilot PR Review

CLI-first pull request review automation for Bitbucket Data Center, powered by the GitHub Copilot SDK.

This project computes a PR diff locally, gives Copilot a tightly scoped read-only view of the changed code, and publishes the result back to Bitbucket as Code Insights reports, annotations, and one tagged summary comment.

## Highlights

- reviews only the changed pull request scope
- runs from your CI workspace instead of shipping repository contents to a separate service
- publishes native Bitbucket review artifacts
- supports single-PR and batch repository review flows
- loads trusted repo-level configuration from the PR base commit

## Requirements

- Node.js 24.12+
- pnpm 10+
- Bitbucket Data Center API access
- a GitHub Copilot-enabled account for CI

## Use With npx

Once published to npm, you can run the CLI directly with `npx`:

```bash
export BITBUCKET_TOKEN="<bitbucket token>"
export REPO_ROOT="/path/to/local/my-repo"

NODE_USE_SYSTEM_CA=1 npx bitbucket-copilot-pr-review review \
  https://bitbucket.example.com/projects/PROJ/repos/my-repo/pull-requests/123 \
  --dry-run
```

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

- `docs/operations.md` - configuration, local testing, batch mode, Jenkins usage, release verification, and npm publishing
- `schemas/copilot-code-review.schema.json` - JSON schema for trusted repo config
- `Jenkinsfile.example` - sample Jenkins pipeline wiring

## Why This Exists

Bitbucket Data Center teams often want Copilot-assisted review inside their existing CI and review workflows. This project keeps the review loop inside your own Bitbucket and CI environment while staying conservative about file access, changed-line validation, and publication behavior.

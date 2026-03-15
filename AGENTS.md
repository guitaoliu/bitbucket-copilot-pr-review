# AGENTS.md

This repository is a Node.js + TypeScript CLI for Bitbucket Data Center PR review automation.
It computes a PR diff locally, asks GitHub Copilot to review only the changed scope, and publishes Code Insights reports, annotations, and one tagged PR comment.

This file is for agentic coding assistants working in this repository.

## Repository scope

- Main runtime entry point: `src/cli.ts`
- Review orchestration: `src/review/runner.ts`
- Repo and env config loading: `src/config/*`
- Copilot prompt, hooks, and tools: `src/copilot/*`
- Bitbucket transport and APIs: `src/bitbucket/*`
- Git access and diff parsing: `src/git/*`
- Review policy and filtering: `src/policy/*`
- Shared helpers: `src/shared/*`

## Special instruction sources

- There is currently no repository-local `.cursorrules` file.
- There is currently no `.cursor/rules/` directory.
- There is currently no `.github/copilot-instructions.md` file.
- The application itself can load a target repository's root `AGENTS.md` from the trusted base commit during review. Do not confuse that target-repo instruction file with this repository's own agent guidance.

## Runtime and package manager

- Use Node.js 24+.
- Use `pnpm` 10+.
- This repo is ESM-only TypeScript with `module` and `moduleResolution` set to `NodeNext` in `tsconfig.json`.
- TypeScript source imports include explicit `.ts` file extensions. Preserve that style.

## Install and setup commands

- Install dependencies: `pnpm install`
- Enable Corepack if needed: `corepack enable`
- Typecheck: `pnpm typecheck`
- Lint + format check: `pnpm check`
- Auto-fix formatting/lint issues: `pnpm check:fix`
- Run all tests: `pnpm test`
- Generate repo config schema: `pnpm generate:repo-config-schema`

## Running the CLI

- Build distributable CLI: `pnpm build`
- Normal run: `pnpm review`
- Dry run without publishing: `pnpm review:dry-run`
- Source invocation: `pnpm review:src:dry-run`
- Built CLI help: `node dist/cli.js --help`

## Single-test commands

- Run one test file: `node --test src/config/load.test.ts`
- Run one named test in one file: `node --test --test-name-pattern="uses simplified defaults" src/config/load.test.ts`
- Run one suite/test pattern across all files: `node --test --test-name-pattern="buildPullRequestComment" "src/**/*.test.ts"`

## Build/lint/test workflow for changes

- For most code changes, run `pnpm test`.
- For config, schema, typing, or API-shape changes, run `pnpm typecheck` and `pnpm test`.
- For formatting-sensitive edits, run `pnpm check` or `pnpm check:fix`.
- If you change `src/config/repo-config.ts` or schema-generation logic, also run `pnpm generate:repo-config-schema` and keep `schemas/copilot-code-review.schema.json` in sync.

## Formatting rules

- Biome is the formatter/linter. Follow `biome.json` rather than personal preferences.
- Use tabs for indentation.
- Use double quotes, not single quotes.
- Keep imports organized. Biome organize-imports is enabled.
- Prefer small, readable functions with explicit helper extraction instead of dense inline logic.
- Preserve existing blank-line rhythm; avoid excessive vertical whitespace.

## Import conventions

- Prefer `import type` for type-only imports.
- Use relative imports with explicit `.ts` extensions.
- Group Node built-ins separately from local imports when the file already follows that pattern.
- Keep import ordering stable and consistent with the rest of the file; let Biome normalize if needed.
- Do not introduce CommonJS syntax.

## TypeScript and typing guidelines

- The repo uses strict TypeScript, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Expect optional access to require care.
- Prefer precise interfaces and discriminated unions over loose object shapes.
- Avoid `any`. Use `unknown` when necessary, then narrow carefully.
- Use `satisfies` when constructing typed object literals that should remain inference-friendly.
- Use `omitUndefined(...)` for payloads or outputs where undefined keys should be removed.
- Keep public return types explicit on exported functions.
- When adding config fields, update all relevant interfaces, parsers, tests, and docs together.

## Naming conventions

- Types, interfaces, and classes: `PascalCase`
- Functions, variables, and object properties: `camelCase`
- Shared constants: `UPPER_SNAKE_CASE` only when they are true module-level constants; otherwise match surrounding style.
- Test names should be behavior-focused and sentence-like, e.g. `it("rejects oversized comments before sending the request", ...)`.
- Prefer descriptive names tied to the domain: `reviewRevision`, `publicationStatus`, `skippedFiles`, `commentStrategy`.

## Error-handling guidelines

- Throw `Error` with actionable, domain-specific messages.
- Include the failing command or resource in infrastructure errors when possible.
- Preserve specialized error classes when the code already uses them, e.g. `BitbucketApiError` in `src/bitbucket/transport.ts`.
- Validate early at boundaries: CLI args, env parsing, repo config parsing, Bitbucket request inputs, and tool arguments.
- Favor runtime validation with Zod for config-like inputs.
- Do not silently swallow errors unless there is an explicit recover-and-continue path with logging.

## Logging conventions

- Use the shared logger from `src/shared/logger.ts`; do not write ad hoc logs unless the file already intentionally writes to stdout/stderr.
- Normal operational logs go through `logger.info`, `logger.warn`, `logger.debug`, `logger.error`.
- Final machine-readable output is printed as JSON on stdout via `logger.json(...)` in `src/cli.ts`.
- Copilot reasoning traces are intentionally routed through `logger.trace(...)` and end up on stderr.
- Keep log messages concise but specific. Include IDs, counts, and revisions when useful.

## Testing conventions

- Tests use the built-in Node test runner from `node:test`.
- Assertions use `node:assert/strict`.
- Prefer focused unit tests near the affected module, using the existing `*.test.ts` layout.
- When changing runtime behavior, add or update tests in the same area rather than relying on end-to-end coverage only.
- Use small fake clients/dependencies and injected functions for orchestration tests, following `src/review/runner.test.ts` patterns.
- Keep tests deterministic; avoid network or real Bitbucket calls.

## Repository-specific coding patterns

- This codebase favors pure helpers and dependency injection over hidden globals.
- Orchestration logic lives in `src/review/*`; low-level API behavior belongs in `src/bitbucket/*`; git command behavior belongs in `src/git/*`.
- Review filtering decisions belong in `src/policy/*`.
- Shared text truncation and formatting helpers belong in `src/shared/text.ts`.
- When adding schema-backed repo config, keep `src/config/repo-config.ts`, `schemas/copilot-code-review.schema.json`, `copilot-code-review.json`, and README examples aligned.

## Config and schema guidance

- Environment variables and CLI flags override repo-level `copilot-code-review.json`.
- Trusted repo config is loaded from the PR base commit, not the workspace head. Preserve that trust model.
- Repo config must stay strict: reject unknown keys and unreasonable values.
- If you add new repo-configurable fields, also update schema generation and validation tests.

## Review-domain constraints

- This product is intentionally conservative about what files Copilot may inspect and what findings may be emitted.
- Do not weaken reviewed-file restrictions, changed-line validation, or path access protections casually.
- `ignorePaths` is for review filtering only; it should not accidentally widen tool access.
- Keep Bitbucket comment/report payload sizes bounded. The repo already has a safety limit for PR comments.

## When editing code

- Prefer minimal, local changes that match existing style.
- Avoid broad refactors unless they are clearly required by the task.
- Do not add comments unless the logic is genuinely non-obvious.
- Do not rename public or widely used symbols without updating all references and tests.
- Keep README and sample config files current when user-facing behavior changes.

## Agent checklist before finishing

- Run the smallest useful test command first, then broader tests if needed.
- Run `pnpm test` for substantive changes.
- Run `pnpm typecheck` when types, config, or exported APIs changed.
- Run `pnpm generate:repo-config-schema` if repo config schema code changed.
- Ensure new imports are organized and formatting matches Biome.
- Mention any follow-up verification the user may want if a command was not run.

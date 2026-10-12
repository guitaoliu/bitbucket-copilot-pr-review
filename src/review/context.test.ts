import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { GitRepository } from "../git/repo.ts";
import {
	createReviewedFileLookup,
	validateFindingLocation,
} from "../policy/findings.ts";
import type { FindingDraft } from "../policy/types.ts";
import type { Logger } from "../shared/logger.ts";
import {
	baseReviewerConfig,
	createPullRequest,
} from "../test-support/review-fixtures.ts";
import { buildReviewContext } from "./context.ts";
import { buildReviewRevision } from "./revision.ts";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

function createGitStub(overrides: Partial<GitRepository> = {}): GitRepository {
	return {
		diffChangedFiles: async () => [
			{
				path: "src/example.ts",
				status: "modified" as const,
				additions: 1,
				deletions: 1,
				isBinary: false,
			},
			{
				path: "pnpm-lock.yaml",
				status: "modified" as const,
				additions: 5,
				deletions: 2,
				isBinary: false,
			},
		],
		diffPaths: async () =>
			[
				"diff --git a/src/example.ts b/src/example.ts",
				"--- a/src/example.ts",
				"+++ b/src/example.ts",
				"@@ -1,2 +1,2 @@",
				" keep",
				"-old",
				"+new",
				"",
			].join("\n"),
		...overrides,
	} as GitRepository;
}

function writeRepoFile(
	root: string,
	filePath: string,
	content: string | Buffer,
) {
	mkdirSync(path.dirname(path.join(root, filePath)), { recursive: true });
	writeFileSync(path.join(root, filePath), content);
}

function finding(path: string, line: number): FindingDraft {
	return {
		path,
		line,
		severity: "HIGH",
		type: "BUG",
		confidence: "high",
		title: "Issue",
		details: "Details.",
	};
}

describe("buildReviewContext", () => {
	it("diffs only reviewable paths once and pins the prompt version in the revision", async () => {
		const diffPathCalls: Array<{ paths: readonly string[]; context: number }> =
			[];
		const git = createGitStub({
			diffPaths: async (_base, _head, paths, contextLines) => {
				diffPathCalls.push({ paths, context: contextLines });
				return "diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n";
			},
		});

		const context = await buildReviewContext(
			{
				config: baseReviewerConfig,
				git,
				mergeBaseCommit: "merge-base-123",
			},
			logger,
			createPullRequest(),
		);

		assert.deepEqual(diffPathCalls, [
			{ paths: ["src/example.ts"], context: 3 },
		]);
		assert.deepEqual(context.diffStats, {
			fileCount: 2,
			additions: 6,
			deletions: 3,
		});
		assert.deepEqual(context.reviewableFiles, [
			{
				path: "src/example.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				isBinary: false,
				changedLines: [1],
			},
		]);
		assert.equal(
			context.reviewRevision,
			buildReviewRevision({
				baseCommit: "base-123",
				headCommit: "head-123",
				mergeBaseCommit: "merge-base-123",
				promptVersion: "2026-09-search-evidence-1",
				copilot: {
					model: baseReviewerConfig.copilot.model,
					reasoningEffort: baseReviewerConfig.copilot.reasoningEffort,
				},
				reviewConfig: {
					minConfidence: baseReviewerConfig.review.minConfidence,
					ignorePaths: [],
					skipBranchPrefixes: ["renovate/"],
				},
			}),
		);
	});

	it("skips the review diff when no file is reviewable", async () => {
		let diffPathCalls = 0;
		const context = await buildReviewContext(
			{
				config: baseReviewerConfig,
				git: createGitStub({
					diffChangedFiles: async () => [
						{
							path: "pnpm-lock.yaml",
							status: "modified",
							additions: 1,
							deletions: 0,
							isBinary: false,
						},
					],
					diffPaths: async () => {
						diffPathCalls += 1;
						return "";
					},
				}),
				mergeBaseCommit: "merge-base-123",
			},
			logger,
			createPullRequest(),
		);

		assert.equal(diffPathCalls, 0);
		assert.deepEqual(context.reviewableFiles, []);
		assert.equal(context.reviewDiff, "");
	});

	it("validates findings against the scope of a real git diff in two passes", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "review-context-"));
		try {
			const git = (...args: string[]) =>
				execFileSync(
					"git",
					[
						"-c",
						"user.name=Test",
						"-c",
						"user.email=test@example.com",
						...args,
					],
					{ cwd: root, encoding: "utf8" },
				).trim();
			const renamedLines = Array.from(
				{ length: 12 },
				(_, index) => `export const value${index} = ${index};`,
			);
			git("init", "--quiet");
			writeRepoFile(
				root,
				"src/app.js",
				"export function same(a, b) {\n\treturn a === b;\n}\n",
			);
			writeRepoFile(root, "src/old-name.js", `${renamedLines.join("\n")}\n`);
			writeRepoFile(root, "assets/logo.png", Buffer.from([0, 1, 2, 3]));
			writeRepoFile(root, ".env", "TOKEN=base-secret\n");
			git("add", "-A");
			git("commit", "--quiet", "-m", "base");
			const base = git("rev-parse", "HEAD");

			writeRepoFile(
				root,
				"src/app.js",
				"export function same(a, b) {\n\tif (a == b) {\n\t\treturn true;\n\t}\n\treturn false;\n}\n",
			);
			git("mv", "src/old-name.js", "src/new-name.js");
			renamedLines[5] = "export const value5 = 50;";
			writeRepoFile(root, "src/new-name.js", `${renamedLines.join("\n")}\n`);
			writeRepoFile(root, "assets/logo.png", Buffer.from([0, 4, 5, 6]));
			writeRepoFile(root, ".env", "TOKEN=head-secret\n");
			git("add", "-A");
			git("commit", "--quiet", "-m", "head");
			const head = git("rev-parse", "HEAD");

			const repo = new GitRepository(root, logger, "origin");
			const pr = createPullRequest(head);
			const context = await buildReviewContext(
				{
					config: { ...baseReviewerConfig, repoRoot: root },
					git: repo,
					mergeBaseCommit: base,
				},
				logger,
				{ ...pr, target: { ...pr.target, latestCommit: base } },
			);

			assert.equal(repo.getTelemetrySnapshot().byOperation.diff?.count, 2);
			assert.equal(context.diffStats.fileCount, 4);
			assert.deepEqual(
				context.reviewableFiles.map((file) => [
					file.status,
					file.oldPath,
					file.path,
					file.changedLines,
				]),
				[
					["modified", undefined, "src/app.js", [2, 3, 4, 5]],
					["renamed", "src/old-name.js", "src/new-name.js", [6]],
				],
			);
			assert.doesNotMatch(context.reviewDiff, /secret|logo\.png/);

			const lookup = createReviewedFileLookup(context.reviewableFiles);
			const validate = (draft: FindingDraft) => {
				const result = validateFindingLocation(draft, lookup);
				return result.ok
					? `${result.draft.path}:${result.draft.line}`
					: result.reason;
			};
			assert.equal(validate(finding("src/app.js", 2)), "src/app.js:2");
			assert.equal(validate(finding("src/app.js", 1)), "unchanged_line");
			assert.equal(validate(finding("src/app.js", 6)), "unchanged_line");
			assert.equal(
				validate(finding("src/old-name.js", 6)),
				"src/new-name.js:6",
			);
			assert.equal(validate(finding("src/new-name.js", 7)), "unchanged_line");
			assert.equal(validate(finding("assets/logo.png", 0)), "unknown_file");
			assert.equal(validate(finding(".env", 0)), "unknown_file");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

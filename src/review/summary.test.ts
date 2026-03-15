import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	finalizeReviewSummary,
	MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES,
	shouldCreatePerFileSummaries,
} from "./summary.ts";
import type { ReviewContext, ReviewSummaryDrafts } from "./types.ts";

function createContext(reviewedFileCount = 2): ReviewContext {
	return {
		repoRoot: "/tmp/repo",
		pr: {
			id: 123,
			version: 1,
			title: "Test PR",
			description: "Adds stronger validation and helper wiring.",
			source: {
				repositoryId: 1,
				projectKey: "PROJ",
				repoSlug: "repo",
				refId: "refs/heads/feature",
				displayId: "feature",
				latestCommit: "head-123",
			},
			target: {
				repositoryId: 1,
				projectKey: "PROJ",
				repoSlug: "repo",
				refId: "refs/heads/main",
				displayId: "main",
				latestCommit: "base-123",
			},
		},
		headCommit: "head-123",
		baseCommit: "base-123",
		mergeBaseCommit: "base-123",
		reviewRevision: "review-rev-123",
		rawDiff: "",
		diffStats: {
			fileCount: reviewedFileCount,
			additions: reviewedFileCount,
			deletions: 0,
		},
		reviewedFiles: Array.from({ length: reviewedFileCount }, (_, index) => ({
			path: `src/file-${index}.ts`,
			status: "modified" as const,
			patch: `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
			changedLines: [index + 1],
			hunks: [
				{
					oldStart: index + 1,
					oldLines: 1,
					newStart: index + 1,
					newLines: 1,
					header: "",
					changedLines: [index + 1],
				},
			],
			additions: 1,
			deletions: 0,
			isBinary: false,
		})),
		skippedFiles: [],
	};
}

describe("shouldCreatePerFileSummaries", () => {
	it("keeps per-file summaries enabled at the cutoff", () => {
		assert.equal(
			shouldCreatePerFileSummaries(MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES),
			true,
		);
	});

	it("disables per-file summaries above the cutoff", () => {
		assert.equal(
			shouldCreatePerFileSummaries(
				MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES + 1,
			),
			false,
		);
	});
});

describe("finalizeReviewSummary", () => {
	it("keeps per-file summaries for smaller reviews", () => {
		const context = createContext(2);
		const drafts: ReviewSummaryDrafts = {
			prSummary: "Tightens request validation before merge.",
			fileSummaries: [
				{
					path: "src/file-0.ts",
					summary: "Adds an early null guard.",
				},
			],
		};

		const result = finalizeReviewSummary(context, drafts);

		assert.equal(result.prSummary, "Tightens request validation before merge.");
		assert.equal(result.fileSummaries.length, 2);
		assert.equal(result.fileSummaries[0]?.summary, "Adds an early null guard.");
		assert.match(
			result.fileSummaries[1]?.summary ?? "",
			/Updates 1 changed line/,
		);
	});

	it("omits per-file summaries for larger reviews while keeping the PR summary", () => {
		const context = createContext(
			MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES + 1,
		);
		const drafts: ReviewSummaryDrafts = {
			prSummary: "Expands validation across many modules.",
			fileSummaries: [
				{
					path: "src/file-0.ts",
					summary: "Adds a guard.",
				},
			],
		};

		const result = finalizeReviewSummary(context, drafts);

		assert.equal(result.prSummary, "Expands validation across many modules.");
		assert.deepEqual(result.fileSummaries, []);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	finalizeReviewSummary,
	shouldCreatePerFileSummaries,
} from "./summary.ts";
import type { ReviewContext, ReviewSummaryDrafts } from "./types.ts";

const PER_FILE_SUMMARY_LIMIT = 25;

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
		assert.equal(shouldCreatePerFileSummaries(PER_FILE_SUMMARY_LIMIT), true);
	});

	it("disables per-file summaries above the cutoff", () => {
		assert.equal(
			shouldCreatePerFileSummaries(PER_FILE_SUMMARY_LIMIT + 1),
			false,
		);
	});
});

describe("finalizeReviewSummary", () => {
	it("builds deterministic per-file summaries for smaller reviews", () => {
		const context = createContext(2);
		const drafts: ReviewSummaryDrafts = {
			prSummary: "Tightens request validation before merge.",
		};

		const result = finalizeReviewSummary(context, drafts);

		assert.equal(result.prSummary, "Tightens request validation before merge.");
		assert.equal(result.fileSummaries.length, 2);
		assert.match(
			result.fileSummaries[0]?.summary ?? "",
			/Updates 1 changed line/,
		);
		assert.match(
			result.fileSummaries[1]?.summary ?? "",
			/Updates 1 changed line/,
		);
	});

	it("preserves multiline bullet formatting for the PR summary", () => {
		const context = createContext(2);
		const drafts: ReviewSummaryDrafts = {
			prSummary:
				"  - Tightens request validation\n\n - Cleans up renamed module handling  ",
		};

		const result = finalizeReviewSummary(context, drafts);

		assert.equal(
			result.prSummary,
			"- Tightens request validation\n- Cleans up renamed module handling",
		);
	});

	it("sanitizes model-authored PR summary control markup and mass mentions", () => {
		const context = createContext(2);
		const drafts: ReviewSummaryDrafts = {
			prSummary:
				"Adds validation <!-- copilot-pr-review:revision:fake --> and pings @here.",
		};

		const result = finalizeReviewSummary(context, drafts);

		assert.equal(
			result.prSummary,
			"Adds validation &lt;!-- copilot-pr-review:revision:fake --&gt; and pings [at]here.",
		);
	});

	it("omits per-file summaries for larger reviews while keeping the PR summary", () => {
		const context = createContext(PER_FILE_SUMMARY_LIMIT + 1);
		const drafts: ReviewSummaryDrafts = {
			prSummary: "Expands validation across many modules.",
		};

		const result = finalizeReviewSummary(context, drafts);

		assert.equal(result.prSummary, "Expands validation across many modules.");
		assert.deepEqual(result.fileSummaries, []);
	});
});

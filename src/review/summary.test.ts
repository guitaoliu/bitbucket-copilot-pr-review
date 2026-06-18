import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { finalizeReviewSummary } from "./summary.ts";
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

describe("finalizeReviewSummary", () => {
	it("keeps the PR summary without building generic file summaries", () => {
		const context = createContext(2);
		const drafts: ReviewSummaryDrafts = {
			prSummary: "Tightens request validation before merge.",
			changeAreas: [
				{
					title: "Validation flow",
					paths: ["src/file-0.ts", "src/file-1.ts"],
					summary: "Updates validation callers together.",
				},
			],
		};

		const result = finalizeReviewSummary(context, drafts);

		assert.equal(result.prSummary, "Tightens request validation before merge.");
		assert.deepEqual(result.changeAreas, drafts.changeAreas);
		assert.deepEqual(result.fileSummaries, []);
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

	it("keeps longer PR summaries without a visible truncation marker", () => {
		const context = createContext(2);
		const prSummary = [
			"- Adds explicit forwarded-host policy controls so callers can choose whether to trust or ignore X-Forwarded-Host.",
			"- Updates router account-resolution paths to ignore external X-Forwarded-Host and pass explicit host and vanity values into account lookup.",
			"- Refactors router filter factory entry points so host handling stays explicit across account lookup, rate limiting, circuit breaking, and bulkheads.",
			"- Extends hostname, account context, account lookup cache, and X-Forwarded-For tests to cover the safer forwarded-host behavior.",
		].join("\n");

		const result = finalizeReviewSummary(context, { prSummary });

		assert.equal(result.prSummary, prSummary);
		assert.doesNotMatch(result.prSummary, /truncated/i);
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

	it("omits file summaries for larger reviews while keeping the PR summary", () => {
		const context = createContext(26);
		const drafts: ReviewSummaryDrafts = {
			prSummary: "Expands validation across many modules.",
		};

		const result = finalizeReviewSummary(context, drafts);

		assert.equal(result.prSummary, "Expands validation across many modules.");
		assert.deepEqual(result.fileSummaries, []);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReviewRevision } from "./revision.ts";

describe("buildReviewRevision", () => {
	it("changes when CI summary changes", () => {
		const baseInput = {
			baseCommit: "base-123",
			mergeBaseCommit: "merge-123",
			rawDiff: "diff --git a/src/file.ts b/src/file.ts",
			promptVersion: "2026-05-accuracy-stability-1",
			copilot: {
				model: "gpt-5.3-codex",
				reasoningEffort: "xhigh",
			},
			reviewConfig: {
				maxFiles: 100,
				maxFindings: 10,
				minConfidence: "high",
				maxPatchChars: 12_000,
				defaultFileSliceLines: 250,
				maxFileSliceLines: 400,
				ignorePaths: [],
				skipBranchPrefixes: ["renovate/"],
			},
		} as const;

		const first = buildReviewRevision({
			...baseInput,
			ciSummary: "ci ok",
		});
		const second = buildReviewRevision({
			...baseInput,
			ciSummary: "ci failed",
		});

		assert.notEqual(first, second);
	});

	it("changes when effective review config changes", () => {
		const first = buildReviewRevision({
			baseCommit: "base-123",
			mergeBaseCommit: "merge-123",
			rawDiff: "diff --git a/src/file.ts b/src/file.ts",
			promptVersion: "2026-05-accuracy-stability-1",
			copilot: {
				model: "gpt-5.3-codex",
				reasoningEffort: "xhigh",
			},
			reviewConfig: {
				maxFiles: 100,
				maxFindings: 10,
				minConfidence: "high",
				maxPatchChars: 12_000,
				defaultFileSliceLines: 250,
				maxFileSliceLines: 400,
				ignorePaths: [],
				skipBranchPrefixes: ["renovate/"],
			},
		});
		const second = buildReviewRevision({
			baseCommit: "base-123",
			mergeBaseCommit: "merge-123",
			rawDiff: "diff --git a/src/file.ts b/src/file.ts",
			promptVersion: "2026-05-accuracy-stability-1",
			copilot: {
				model: "gpt-5.3-codex",
				reasoningEffort: "xhigh",
			},
			reviewConfig: {
				maxFiles: 100,
				maxFindings: 10,
				minConfidence: "medium",
				maxPatchChars: 12_000,
				defaultFileSliceLines: 250,
				maxFileSliceLines: 400,
				ignorePaths: [],
				skipBranchPrefixes: ["renovate/"],
			},
		});

		assert.notEqual(first, second);
	});
});

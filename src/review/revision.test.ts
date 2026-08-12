import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildReviewRevision } from "./revision.ts";

describe("buildReviewRevision", () => {
	it("changes when CI summary changes", () => {
		const baseInput = {
			baseCommit: "base-123",
			headCommit: "head-123",
			mergeBaseCommit: "merge-123",
			promptVersion: "2026-05-accuracy-stability-1",
			copilot: {
				model: "gpt-5.3-codex",
				reasoningEffort: "xhigh",
			},
			reviewConfig: {
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
			headCommit: "head-123",
			mergeBaseCommit: "merge-123",
			promptVersion: "2026-05-accuracy-stability-1",
			copilot: {
				model: "gpt-5.3-codex",
				reasoningEffort: "xhigh",
			},
			reviewConfig: {
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
			headCommit: "head-123",
			mergeBaseCommit: "merge-123",
			promptVersion: "2026-05-accuracy-stability-1",
			copilot: {
				model: "gpt-5.3-codex",
				reasoningEffort: "xhigh",
			},
			reviewConfig: {
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

	it("changes when head commit changes", () => {
		const first = buildReviewRevision({
			baseCommit: "base-123",
			headCommit: "head-123",
			mergeBaseCommit: "merge-123",
		});
		const second = buildReviewRevision({
			baseCommit: "base-123",
			headCommit: "head-456",
			mergeBaseCommit: "merge-123",
		});

		assert.notEqual(first, second);
	});
});

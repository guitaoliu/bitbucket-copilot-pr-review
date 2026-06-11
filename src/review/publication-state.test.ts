import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFindingThreadKey } from "./finding-identity.ts";
import {
	buildPullRequestCommentMetadataMarkers,
	parsePullRequestCommentMetadata,
} from "./publication-state.ts";

describe("publication completeness", () => {
	it("parses revision markers from tagged comments", () => {
		const metadata = parsePullRequestCommentMetadata(
			"copilot-pr-review",
			[
				"<!-- copilot-pr-review -->",
				"<!-- copilot-pr-review:schema:2 -->",
				"<!-- copilot-pr-review:revision:review-rev-123 -->",
				"<!-- copilot-pr-review:reviewed-commit:head-123 -->",
				"<!-- copilot-pr-review:published-commit:head-456 -->",
			].join("\n"),
		);

		assert.deepEqual(metadata, {
			schema: "2",
			revision: "review-rev-123",
			reviewedCommit: "head-123",
			publishedCommit: "head-456",
		});
	});

	it("parses stored findings metadata from tagged comments", () => {
		const comment = [
			"<!-- copilot-pr-review -->",
			...buildPullRequestCommentMetadataMarkers({
				tag: "copilot-pr-review",
				revision: "review-rev-123",
				reviewedCommit: "head-123",
				publishedCommit: "head-123",
				findingsJson: JSON.stringify([
					{
						path: "src/service.ts",
						line: 42,
						severity: "HIGH",
						type: "BUG",
						title: "Null handling is broken",
					},
				]),
			}),
		].join("\n");

		const metadata = parsePullRequestCommentMetadata(
			"copilot-pr-review",
			comment,
		);

		assert.deepEqual(metadata?.storedFindings, [
			{
				path: "src/service.ts",
				line: 42,
				severity: "HIGH",
				type: "BUG",
				title: "Null handling is broken",
				threadKey: buildFindingThreadKey({
					path: "src/service.ts",
					line: 42,
					type: "BUG",
				}),
			},
		]);
	});

	it("derives missing thread keys for stored findings", () => {
		const comment = [
			"<!-- copilot-pr-review -->",
			...buildPullRequestCommentMetadataMarkers({
				tag: "copilot-pr-review",
				revision: "review-rev-123",
				reviewedCommit: "head-123",
				publishedCommit: "head-123",
				findingsJson: JSON.stringify([
					{
						path: "src/service.ts",
						line: 42,
						severity: "HIGH",
						type: "BUG",
						title: "Null handling is broken",
					},
				]),
			}),
		].join("\n");

		const metadata = parsePullRequestCommentMetadata(
			"copilot-pr-review",
			comment,
		);

		assert.ok(metadata?.storedFindings?.[0]?.threadKey);
	});

	it("drops malformed stored findings metadata entries", () => {
		const comment = [
			"<!-- copilot-pr-review -->",
			...buildPullRequestCommentMetadataMarkers({
				tag: "copilot-pr-review",
				revision: "review-rev-123",
				reviewedCommit: "head-123",
				publishedCommit: "head-123",
				findingsJson: JSON.stringify([
					{
						path: "src/service.ts",
						line: 42,
						severity: "HIGH",
						type: "BUG",
						title: "Valid finding",
						confidence: "high",
					},
					{
						path: "src/service.ts",
						line: -1,
						severity: "NOT_A_LEVEL",
						type: "BUG",
						title: "Invalid finding",
					},
					{
						path: "src/other.ts",
						severity: "LOW",
						type: "BUG",
						title: "Also valid",
						details: "Still accepted.",
					},
				]),
			}),
		].join("\n");

		const metadata = parsePullRequestCommentMetadata(
			"copilot-pr-review",
			comment,
		);

		assert.deepEqual(metadata?.storedFindings, [
			{
				path: "src/service.ts",
				line: 42,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Valid finding",
				threadKey: buildFindingThreadKey({
					path: "src/service.ts",
					line: 42,
					type: "BUG",
				}),
			},
			{
				path: "src/other.ts",
				severity: "LOW",
				type: "BUG",
				title: "Also valid",
				details: "Still accepted.",
				threadKey: buildFindingThreadKey({
					path: "src/other.ts",
					line: 0,
					type: "BUG",
				}),
			},
		]);
	});
});

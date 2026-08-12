import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildPullRequestCommentMetadataMarkers,
	parsePullRequestCommentMetadata,
} from "./publication-state.ts";

describe("publication completeness", () => {
	it("parses fixed metadata from tagged comments", () => {
		const metadata = parsePullRequestCommentMetadata(
			"copilot-pr-review",
			[
				"<!-- copilot-pr-review -->",
				...buildPullRequestCommentMetadataMarkers({
					tag: "copilot-pr-review",
					revision: "review-rev-123",
					reviewedCommit: "head-123",
					publishedCommit: "head-456",
					schema: "3",
				}),
			].join("\n"),
		);

		assert.deepEqual(metadata, {
			schema: "3",
			revision: "review-rev-123",
			reviewedCommit: "head-123",
			publishedCommit: "head-456",
		});
	});

	it("ignores legacy findings metadata", () => {
		const metadata = parsePullRequestCommentMetadata(
			"copilot-pr-review",
			[
				"<!-- copilot-pr-review -->",
				"<!-- copilot-pr-review:schema:2 -->",
				"<!-- copilot-pr-review:findings-json:legacy-payload -->",
			].join("\n"),
		);

		assert.deepEqual(metadata, { schema: "2" });
	});
});

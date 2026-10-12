import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	formatRevisionMarker,
	parseSummaryCommentRevision,
} from "./markers.ts";
import {
	buildPublicationStateFields,
	readPublishedReportState,
} from "./publication-state.ts";

describe("publication state", () => {
	it("reads back the revision and finding count it publishes", () => {
		const state = readPublishedReportState({
			data: buildPublicationStateFields({
				revision: "review-rev-123",
				findingCount: 2,
			}),
		});

		assert.deepEqual(state, { revision: "review-rev-123", findingCount: 2 });
	});

	it("accepts numeric strings for the findings count and ignores blank revisions", () => {
		const state = readPublishedReportState({
			data: [
				{ title: "Findings", type: "TEXT", value: " 3 " },
				{ title: "Review revision", type: "TEXT", value: "  " },
			],
		});

		assert.deepEqual(state, { findingCount: 3 });
	});

	it("reads the revision from summary comments written by older versions", () => {
		const revision = parseSummaryCommentRevision(
			"copilot-pr-review",
			[
				"<!-- copilot-pr-review -->",
				"<!-- copilot-pr-review:schema:2 -->",
				formatRevisionMarker("copilot-pr-review", "review-rev-123"),
				"<!-- copilot-pr-review:reviewed-commit:head-123 -->",
			].join("\n"),
		);

		assert.equal(revision, "review-rev-123");
	});

	it("ignores revision markers in comments without the summary tag marker", () => {
		const revision = parseSummaryCommentRevision(
			"copilot-pr-review",
			formatRevisionMarker("copilot-pr-review", "review-rev-123"),
		);

		assert.equal(revision, undefined);
	});
});

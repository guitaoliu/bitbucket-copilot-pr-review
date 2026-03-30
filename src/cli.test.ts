import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldExitNonZeroForReview } from "./cli.ts";

describe("shouldExitNonZeroForReview", () => {
	it("treats skipped reviews as successful exits", () => {
		assert.equal(
			shouldExitNonZeroForReview({
				skipped: true,
			}),
			false,
		);
	});

	it("treats published reviews as successful exits", () => {
		assert.equal(
			shouldExitNonZeroForReview({
				skipped: false,
				publicationStatus: "published",
			}),
			false,
		);
	});

	it("treats dry runs as successful exits", () => {
		assert.equal(
			shouldExitNonZeroForReview({
				skipped: false,
				publicationStatus: "dry_run",
			}),
			false,
		);
	});

	it("treats stale reviews as failed exits", () => {
		assert.equal(
			shouldExitNonZeroForReview({
				skipped: false,
				publicationStatus: "stale",
			}),
			true,
		);
	});

	it("treats partial reviews as failed exits", () => {
		assert.equal(
			shouldExitNonZeroForReview({
				skipped: false,
				publicationStatus: "partial",
			}),
			true,
		);
	});

	it("treats failed reviews as failed exits", () => {
		assert.equal(
			shouldExitNonZeroForReview({
				skipped: false,
				publicationStatus: "failed",
			}),
			true,
		);
	});
});

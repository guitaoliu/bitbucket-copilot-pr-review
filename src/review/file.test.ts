import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getReviewedFilePathForVersion } from "./file.ts";

describe("getReviewedFilePathForVersion", () => {
	it("returns the current path for the head revision", () => {
		assert.equal(
			getReviewedFilePathForVersion(
				{ path: "src/new-name.ts", oldPath: "src/old-name.ts" },
				"head",
			),
			"src/new-name.ts",
		);
	});

	it("uses oldPath for base content on renamed files", () => {
		assert.equal(
			getReviewedFilePathForVersion(
				{ path: "src/new-name.ts", oldPath: "src/old-name.ts" },
				"base",
			),
			"src/old-name.ts",
		);
	});

	it("falls back to the current path when oldPath is absent", () => {
		assert.equal(
			getReviewedFilePathForVersion({ path: "src/example.ts" }, "base"),
			"src/example.ts",
		);
	});
});

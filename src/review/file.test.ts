import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChangedFile } from "../git/types.ts";
import {
	createReviewedFileLookup,
	getReviewedFilePathForVersion,
} from "./file.ts";

describe("getReviewedFilePathForVersion", () => {
	it("returns the current path for the head revision", () => {
		assert.equal(
			getReviewedFilePathForVersion(
				{
					path: "src/new-name.ts",
					oldPath: "src/old-name.ts",
					status: "renamed",
				},
				"head",
			),
			"src/new-name.ts",
		);
	});

	it("uses oldPath for base content on renamed files", () => {
		assert.equal(
			getReviewedFilePathForVersion(
				{
					path: "src/new-name.ts",
					oldPath: "src/old-name.ts",
					status: "renamed",
				},
				"base",
			),
			"src/old-name.ts",
		);
	});

	it("uses the current path for base content on copied files", () => {
		assert.equal(
			getReviewedFilePathForVersion(
				{
					path: "src/copied.ts",
					oldPath: "src/original.ts",
					status: "copied",
				},
				"base",
			),
			"src/copied.ts",
		);
	});

	it("falls back to the current path when oldPath is absent", () => {
		assert.equal(
			getReviewedFilePathForVersion(
				{ path: "src/example.ts", status: "modified" },
				"base",
			),
			"src/example.ts",
		);
	});
});

describe("createReviewedFileLookup", () => {
	it("adds oldPath aliases only for renamed files", () => {
		const renamedFile: ChangedFile = {
			path: "src/new-name.ts",
			oldPath: "src/old-name.ts",
			status: "renamed",
			patch: "diff --git a/src/old-name.ts b/src/new-name.ts",
			changedLines: [1],
			hunks: [],
			additions: 1,
			deletions: 1,
			isBinary: false,
		};
		const copiedFile: ChangedFile = {
			path: "src/copied.ts",
			oldPath: "src/original.ts",
			status: "copied",
			patch: "diff --git a/src/original.ts b/src/copied.ts",
			changedLines: [1],
			hunks: [],
			additions: 1,
			deletions: 0,
			isBinary: false,
		};

		const lookup = createReviewedFileLookup([renamedFile, copiedFile]);

		assert.equal(lookup.get("src/new-name.ts"), renamedFile);
		assert.equal(lookup.get("src/old-name.ts"), renamedFile);
		assert.equal(lookup.get("src/copied.ts"), copiedFile);
		assert.equal(lookup.has("src/original.ts"), false);
	});
});

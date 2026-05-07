import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChangedFile } from "../git/types.ts";
import {
	createReviewedFileLookup,
	getReviewedFilePathForVersion,
	normalizeFindingDraftLocation,
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

describe("normalizeFindingDraftLocation", () => {
	it("rejects non-file-level findings on unchanged lines", () => {
		const reviewedFile: ChangedFile = {
			path: "src/new-name.ts",
			status: "modified",
			patch: "diff --git a/src/new-name.ts b/src/new-name.ts",
			changedLines: [10, 11],
			hunks: [],
			additions: 2,
			deletions: 0,
			isBinary: false,
		};

		const result = normalizeFindingDraftLocation(
			{
				path: "src/new-name.ts",
				line: 9,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Wrong line",
				details: "This line is unchanged.",
			},
			createReviewedFileLookup([reviewedFile]),
		);

		assert.deepEqual(result, {
			error: "Line 9 is not a changed line in src/new-name.ts.",
		});
	});

	it("preserves explicit file-level findings", () => {
		const reviewedFile: ChangedFile = {
			path: "src/new-name.ts",
			status: "modified",
			patch: "diff --git a/src/new-name.ts b/src/new-name.ts",
			changedLines: [10, 11],
			hunks: [],
			additions: 2,
			deletions: 0,
			isBinary: false,
		};

		const result = normalizeFindingDraftLocation(
			{
				path: "src/new-name.ts",
				line: 0,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "File issue",
				details: "This applies to the whole changed file.",
			},
			createReviewedFileLookup([reviewedFile]),
		);

		assert.deepEqual(result, {
			normalizedDraft: {
				path: "src/new-name.ts",
				line: 0,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "File issue",
				details: "This applies to the whole changed file.",
			},
		});
	});

	it("remaps nearby lines inside the same changed hunk to the nearest changed line", () => {
		const reviewedFile: ChangedFile = {
			path: "src/new-name.ts",
			status: "modified",
			patch: "diff --git a/src/new-name.ts b/src/new-name.ts",
			changedLines: [10, 12],
			hunks: [
				{
					oldStart: 10,
					oldLines: 3,
					newStart: 10,
					newLines: 4,
					header: "",
					changedLines: [10, 12],
				},
			],
			additions: 2,
			deletions: 1,
			isBinary: false,
		};

		const result = normalizeFindingDraftLocation(
			{
				path: "src/new-name.ts",
				line: 11,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Nearby line",
				details: "Anchored one line away inside the same hunk.",
			},
			createReviewedFileLookup([reviewedFile]),
		);

		assert.deepEqual(result, {
			normalizedDraft: {
				path: "src/new-name.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Nearby line",
				details: "Anchored one line away inside the same hunk.",
			},
			note: "normalized line from 11 to 10.",
		});
	});
});

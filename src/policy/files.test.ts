import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChangedFile } from "../git/types.ts";
import type { FindingDraft } from "../review/types.ts";
import { filterChangedFiles } from "./files.ts";
import { finalizeFindings } from "./findings.ts";
import {
	getRepoDirectoryAccessDecision,
	getRepoFileAccessDecision,
} from "./path-access.ts";

const reviewedFile: ChangedFile = {
	path: "src/service.ts",
	status: "modified",
	patch:
		"diff --git a/src/service.ts b/src/service.ts\n@@ -8,1 +10,2 @@\n-foo\n+bar\n+baz",
	changedLines: [10, 11],
	hunks: [
		{
			oldStart: 8,
			oldLines: 1,
			newStart: 10,
			newLines: 2,
			header: "",
			changedLines: [10, 11],
		},
	],
	additions: 2,
	deletions: 1,
	isBinary: false,
};

describe("filterChangedFiles", () => {
	it("skips generated and deleted files", () => {
		const result = filterChangedFiles(
			[
				reviewedFile,
				{
					...reviewedFile,
					path: "pnpm-lock.yaml",
					changedLines: [1],
					status: "modified",
				},
				{
					...reviewedFile,
					path: "src/removed.ts",
					status: "deleted",
					changedLines: [],
				},
			],
			10,
		);

		assert.equal(result.reviewedFiles.length, 1);
		assert.equal(result.skippedFiles.length, 2);
		assert.equal(result.skippedFiles[0]?.reason, "lockfile");
		assert.equal(result.skippedFiles[1]?.reason, "deleted file");
	});

	it("skips files matching configured ignore globs", () => {
		const result = filterChangedFiles(
			[
				{ ...reviewedFile, path: "i18n/locales/en.json" },
				{ ...reviewedFile, path: "i18n/locales/app/fr/common.json" },
				{ ...reviewedFile, path: "src/i18n/locales.ts" },
			],
			10,
			["i18n/locales/**/*.json"],
		);

		assert.deepEqual(
			result.reviewedFiles.map((file) => file.path),
			["src/i18n/locales.ts"],
		);
		assert.deepEqual(
			result.skippedFiles.map((file) => file.reason),
			[
				"ignored path pattern (i18n/locales/**/*.json)",
				"ignored path pattern (i18n/locales/**/*.json)",
			],
		);
	});
});

describe("repo path access decisions", () => {
	it("allows safe related file paths and normalizes them", () => {
		const decision = getRepoFileAccessDecision("src/../src/service.ts");

		assert.equal(decision.include, true);
		assert.equal(decision.normalizedPath, "src/service.ts");
	});

	it("rejects path traversal and secret-bearing paths", () => {
		const traversal = getRepoFileAccessDecision("../secrets.txt");
		const secret = getRepoFileAccessDecision("config/.env.local");

		assert.equal(traversal.include, false);
		assert.match(traversal.reason ?? "", /repo-relative/);
		assert.equal(secret.include, false);
		assert.equal(secret.reason, "potential secret-bearing path");
	});

	it("rejects excluded directories for directory listing", () => {
		const decision = getRepoDirectoryAccessDecision("node_modules/internal");

		assert.equal(decision.include, false);
		assert.equal(decision.reason, "generated or vendored path");
	});
});

describe("finalizeFindings", () => {
	it("keeps only threshold-meeting, non-duplicate findings on changed lines", () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/service.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Null handling is broken",
				details: "The new branch dereferences a possibly null response.",
			},
			{
				path: "src/service.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Null handling is broken",
				details: "The new branch dereferences a possibly null response.",
			},
			{
				path: "src/service.ts",
				line: 9,
				severity: "MEDIUM",
				type: "CODE_SMELL",
				confidence: "high",
				title: "Wrong line",
				details: "This line was not changed.",
			},
			{
				path: "src/service.ts",
				line: 11,
				severity: "LOW",
				type: "CODE_SMELL",
				confidence: "medium",
				title: "Low confidence note",
				details: "Should not survive the threshold.",
			},
		];

		const findings = finalizeFindings(drafts, [reviewedFile], 5, "high");
		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.line, 10);
		assert.ok(findings[0]?.externalId.startsWith("finding-"));
	});

	it("keeps file-level findings and normalizes oldPath entries to the head path", () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/service.ts",
				line: 0,
				severity: "HIGH",
				type: "BUG",
				confidence: "medium",
				title: "File-level issue",
				details: "Applies to the whole changed file.",
			},
			{
				path: "src/old-service.ts",
				line: 10,
				severity: "MEDIUM",
				type: "BUG",
				confidence: "medium",
				title: "Renamed path issue",
				details: "Originally reported against the base path.",
			},
		];

		const findings = finalizeFindings(
			drafts,
			[{ ...reviewedFile, oldPath: "src/old-service.ts" }],
			5,
			"medium",
		);

		assert.equal(findings.length, 2);
		assert.deepEqual(
			findings.map((finding) => ({
				path: finding.path,
				line: finding.line,
				title: finding.title,
			})),
			[
				{ path: "src/service.ts", line: 0, title: "File-level issue" },
				{ path: "src/service.ts", line: 10, title: "Renamed path issue" },
			],
		);
	});
});

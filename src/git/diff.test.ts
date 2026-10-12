import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	parseChangedFiles,
	parseChangedLines,
	summarizeDiffStats,
} from "./diff.ts";

const SHAS = "100644 100644 1111111 2222222";

describe("parseChangedFiles", () => {
	it("joins raw status records with numstat records by head path", () => {
		const files = parseChangedFiles(
			[
				`:${SHAS} M`,
				"src/service.ts",
				":000000 100644 0000000 2222222 A",
				"pages/[id].tsx",
				`:${SHAS} R100`,
				"old name.ts",
				"new name.ts",
				`:${SHAS} C075`,
				"src/source.ts",
				"src/copy.ts",
				`:${SHAS} T`,
				"script/run",
				`:${SHAS} M`,
				"assets/logo.png",
				":100644 000000 1111111 0000000 D",
				"unicodé/removed.ts",
				"2\t1\tsrc/service.ts",
				"3\t0\tpages/[id].tsx",
				"0\t0\t",
				"old name.ts",
				"new name.ts",
				"1\t0\t",
				"src/source.ts",
				"src/copy.ts",
				"1\t1\tscript/run",
				"-\t-\tassets/logo.png",
				"0\t4\tunicodé/removed.ts",
				"",
			].join("\0"),
		);

		assert.deepEqual(files, [
			{
				path: "src/service.ts",
				status: "modified",
				additions: 2,
				deletions: 1,
				isBinary: false,
			},
			{
				path: "pages/[id].tsx",
				status: "added",
				additions: 3,
				deletions: 0,
				isBinary: false,
			},
			{
				path: "new name.ts",
				oldPath: "old name.ts",
				status: "renamed",
				additions: 0,
				deletions: 0,
				isBinary: false,
			},
			{
				path: "src/copy.ts",
				oldPath: "src/source.ts",
				status: "copied",
				additions: 1,
				deletions: 0,
				isBinary: false,
			},
			{
				path: "script/run",
				status: "modified",
				additions: 1,
				deletions: 1,
				isBinary: false,
			},
			{
				path: "assets/logo.png",
				status: "modified",
				additions: 0,
				deletions: 0,
				isBinary: true,
			},
			{
				path: "unicodé/removed.ts",
				status: "deleted",
				additions: 0,
				deletions: 4,
				isBinary: false,
			},
		]);
		assert.deepEqual(summarizeDiffStats(files), {
			fileCount: 7,
			additions: 7,
			deletions: 6,
		});
	});

	it("skips unknown statuses without misreading their paths", () => {
		const files = parseChangedFiles(
			[
				`:${SHAS} U`,
				"M",
				`:${SHAS} M`,
				"src/next.ts",
				"1\t0\tsrc/next.ts",
				"",
			].join("\0"),
		);

		assert.deepEqual(
			files.map((file) => file.path),
			["src/next.ts"],
		);
	});
});

function changedLineEntries(diff: string) {
	return Object.fromEntries(
		[...parseChangedLines(diff)].map(([path, lines]) => [path, [...lines]]),
	);
}

describe("parseChangedLines", () => {
	it("collects added head lines with their text and ignores context and removed lines", () => {
		const diff = [
			"diff --git a/src/example.ts b/src/example.ts",
			"index 1111111..2222222 100644",
			"--- a/src/example.ts",
			"+++ b/src/example.ts",
			"@@ -1,4 +1,5 @@ export function example() {",
			" const a = 1;",
			"-const b = 2;",
			"+const b = 3;",
			"++const c = 4;",
			" return a;",
			" }",
			"@@ -20,3 +21,2 @@",
			" one",
			"-two",
			" three",
			"\\ No newline at end of file",
			"diff --git a/src/new file.ts b/src/new file.ts",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/src/new file.ts\t",
			"@@ -0,0 +1,2 @@",
			"+line 1",
			"+line 2",
			"diff --git a/src/removed.ts b/src/removed.ts",
			"deleted file mode 100644",
			"--- a/src/removed.ts",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-gone",
			"",
		].join("\n");

		assert.deepEqual(changedLineEntries(diff), {
			"src/example.ts": [
				[2, "const b = 3;"],
				[3, "+const c = 4;"],
			],
			"src/new file.ts": [
				[1, "line 1"],
				[2, "line 2"],
			],
			"src/removed.ts": [],
		});
	});

	it("keys renames and copies by their head path", () => {
		const diff = [
			"diff --git a/src/old-name.ts b/src/new-name.ts",
			"similarity index 90%",
			"rename from src/old-name.ts",
			"rename to src/new-name.ts",
			"--- a/src/old-name.ts",
			"+++ b/src/new-name.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"diff --git a/src/a.ts b/src/a b.ts",
			"similarity index 100%",
			"copy from src/a.ts",
			'copy to "src/a b\\t.ts"',
			"diff --git a/assets/logo.png b/assets/logo.png",
			"Binary files a/assets/logo.png and b/assets/logo.png differ",
			'diff --git "a/src/tab\\there.ts" "b/src/tab\\there.ts"',
			'--- "a/src/tab\\there.ts"',
			'+++ "b/src/tab\\there.ts"',
			"@@ -3,0 +4 @@",
			"+added",
		].join("\n");

		assert.deepEqual(changedLineEntries(diff), {
			"src/new-name.ts": [[1, "new"]],
			"src/a b\t.ts": [],
			"assets/logo.png": [],
			"src/tab\there.ts": [[4, "added"]],
		});
	});

	it("returns no files for an empty diff", () => {
		assert.equal(parseChangedLines("").size, 0);
	});
});

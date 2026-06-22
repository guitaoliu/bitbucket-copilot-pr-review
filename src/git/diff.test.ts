import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	applyNumstatDiff,
	parseNameStatusDiff,
	parseUnifiedDiff,
} from "./diff.ts";

describe("parseNameStatusDiff", () => {
	it("parses NUL-delimited changed path metadata", () => {
		const files = parseNameStatusDiff(
			[
				"M",
				"src/service.ts",
				"A",
				"pages/[id].tsx",
				"R100",
				"old name.ts",
				"new name.ts",
				"C075",
				"src/source.ts",
				"src/copy.ts",
				"D",
				"unicodé/removed.ts",
				"",
			].join("\0"),
		);

		assert.deepEqual(files, [
			{
				path: "src/service.ts",
				status: "modified",
				additions: 0,
				deletions: 0,
				isBinary: false,
			},
			{
				path: "pages/[id].tsx",
				status: "added",
				additions: 0,
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
				additions: 0,
				deletions: 0,
				isBinary: false,
			},
			{
				path: "unicodé/removed.ts",
				status: "deleted",
				additions: 0,
				deletions: 0,
				isBinary: false,
			},
		]);
	});
});

describe("applyNumstatDiff", () => {
	it("adds stats and binary flags to changed path metadata", () => {
		const files = parseNameStatusDiff(
			[
				"M",
				"src/service.ts",
				"R050",
				"old name.ts",
				"new name.ts",
				"A",
				"image.png",
				"",
			].join("\0"),
		);

		const stats = applyNumstatDiff(
			files,
			[
				"2\t1\tsrc/service.ts",
				"1\t0\t",
				"old name.ts",
				"new name.ts",
				"-\t-\timage.png",
				"",
			].join("\0"),
		);

		assert.deepEqual(stats, { fileCount: 3, additions: 3, deletions: 1 });
		assert.equal(files[0]?.additions, 2);
		assert.equal(files[1]?.path, "new name.ts");
		assert.equal(files[1]?.additions, 1);
		assert.equal(files[2]?.isBinary, true);
	});

	it("keeps type-change records aligned with numstat records", () => {
		const files = parseNameStatusDiff(
			["M", "src/service.ts", "T", "script/run", "M", "src/next.ts", ""].join(
				"\0",
			),
		);

		const stats = applyNumstatDiff(
			files,
			[
				"2\t1\tsrc/service.ts",
				"1\t3\tscript/run",
				"5\t6\tsrc/next.ts",
				"",
			].join("\0"),
		);

		assert.deepEqual(stats, { fileCount: 3, additions: 8, deletions: 10 });
		assert.equal(files[1]?.path, "script/run");
		assert.equal(files[1]?.status, "modified");
		assert.equal(files[1]?.additions, 1);
		assert.equal(files[2]?.path, "src/next.ts");
		assert.equal(files[2]?.additions, 5);
		assert.equal(files[2]?.deletions, 6);
	});
});

describe("parseUnifiedDiff", () => {
	it("captures modified and added file line ranges", () => {
		const diff = [
			"diff --git a/src/example.ts b/src/example.ts",
			"index 1111111..2222222 100644",
			"--- a/src/example.ts",
			"+++ b/src/example.ts",
			"@@ -1,4 +1,5 @@",
			" const a = 1;",
			"-const b = 2;",
			"+const b = 3;",
			"+const c = 4;",
			" return a + b;",
			"diff --git a/src/new.ts b/src/new.ts",
			"new file mode 100644",
			"index 0000000..3333333",
			"--- /dev/null",
			"+++ b/src/new.ts",
			"@@ -0,0 +1,2 @@",
			"+export const created = true;",
			"+export const value = 42;",
		].join("\n");

		const parsed = parseUnifiedDiff(diff);

		assert.equal(parsed.stats.fileCount, 2);
		assert.equal(parsed.stats.additions, 4);
		assert.equal(parsed.stats.deletions, 1);
		assert.equal(parsed.files[0]?.path, "src/example.ts");
		assert.deepEqual(parsed.files[0]?.changedLines, [2, 3]);
		assert.equal(parsed.files[1]?.status, "added");
		assert.deepEqual(parsed.files[1]?.changedLines, [1, 2]);
	});

	it("tracks renames", () => {
		const diff = [
			"diff --git a/src/old-name.ts b/src/new-name.ts",
			"similarity index 98%",
			"rename from src/old-name.ts",
			"rename to src/new-name.ts",
			"@@ -1,1 +1,1 @@",
			"-export const value = 1;",
			"+export const value = 2;",
		].join("\n");

		const parsed = parseUnifiedDiff(diff);
		assert.equal(parsed.files[0]?.status, "renamed");
		assert.equal(parsed.files[0]?.oldPath, "src/old-name.ts");
		assert.equal(parsed.files[0]?.path, "src/new-name.ts");
		assert.deepEqual(parsed.files[0]?.changedLines, [1]);
	});
});

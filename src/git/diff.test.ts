import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildSymbolSearchPattern,
	escapeRegexLiteral,
	parseUnifiedDiff,
} from "./diff.ts";
import { parseGitGrepLine } from "./search.ts";

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

describe("git search helpers", () => {
	it("escapes regex literals safely", () => {
		assert.equal(
			escapeRegexLiteral("service.get(value)"),
			"service\\.get\\(value\\)",
		);
	});

	it("builds whole-symbol style regex patterns", () => {
		assert.equal(
			buildSymbolSearchPattern("AuthService"),
			"(^|[^A-Za-z0-9_])AuthService([^A-Za-z0-9_]|$)",
		);
	});

	it("parses git grep output with a tree-ish prefix", () => {
		assert.deepEqual(
			parseGitGrepLine("abc123:src/service.ts:42:const result = AuthService()"),
			{
				path: "src/service.ts",
				line: 42,
				text: "const result = AuthService()",
			},
		);
	});

	it("parses git grep output without a tree-ish prefix", () => {
		assert.deepEqual(
			parseGitGrepLine("src/service.ts:7:export const value = 1"),
			{
				path: "src/service.ts",
				line: 7,
				text: "export const value = 1",
			},
		);
	});

	it("parses git grep output for paths containing colons", () => {
		assert.deepEqual(parseGitGrepLine("dir:a.ts:7:export const value = 1"), {
			path: "dir:a.ts",
			line: 7,
			text: "export const value = 1",
		});
	});

	it("parses null-delimited git grep output for paths containing colons", () => {
		assert.deepEqual(
			parseGitGrepLine("abc123:dir:a.ts\u00007\u0000export const value = 1"),
			{
				path: "dir:a.ts",
				line: 7,
				text: "export const value = 1",
			},
		);
	});

	it("returns undefined for malformed grep lines", () => {
		assert.equal(parseGitGrepLine("not-a-match"), undefined);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseUnifiedDiff } from "./diff.ts";

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

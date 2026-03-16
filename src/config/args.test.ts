import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getHelpText, parseCliArgs } from "./args.ts";

describe("parseCliArgs", () => {
	it("accepts CLI aliases from shared metadata", () => {
		const parsed = parseCliArgs(["--no-publish", "--force-review"]);

		assert.equal(parsed.dryRun, true);
		assert.equal(parsed.forceReview, true);
	});

	it("parses valued options", () => {
		const parsed = parseCliArgs(["--repo-root", "/tmp/repo"]);

		assert.equal(parsed.repoRoot, "/tmp/repo");
	});

	it("parses batch review options", () => {
		const parsed = parseCliArgs([
			"--repo-id",
			"AAAS/sbp",
			"--temp-root",
			"/tmp/batch",
			"--max-parallel",
			"3",
			"--keep-workdirs",
		]);

		assert.equal(parsed.repoId, "AAAS/sbp");
		assert.equal(parsed.tempRoot, "/tmp/batch");
		assert.equal(parsed.maxParallel, 3);
		assert.equal(parsed.keepWorkdirs, true);
	});
});

describe("getHelpText", () => {
	it("renders help lines from shared CLI metadata", () => {
		const helpText = getHelpText();

		assert.match(helpText, /Usage: bitbucket-copilot-pr-review \[options\]/);
		assert.match(helpText, /--dry-run, --no-publish/);
		assert.match(helpText, /--repo-root <path>/);
		assert.match(helpText, /--repo-id <project\/repo>/);
		assert.match(helpText, /--keep-workdirs/);
		assert.match(helpText, /-h, --help/);
	});
});

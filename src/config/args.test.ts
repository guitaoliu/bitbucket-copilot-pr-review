import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	getHelpText,
	isBatchCliOptions,
	isReviewCliOptions,
	parseCliArgs,
} from "./args.ts";

describe("parseCliArgs", () => {
	it("parses review command options", () => {
		const parsed = parseCliArgs([
			"review",
			"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123",
			"--dry-run",
			"--force-review",
			"--repo-root",
			"/tmp/repo",
		]);

		assert.equal(isReviewCliOptions(parsed), true);
		if (!isReviewCliOptions(parsed)) {
			throw new Error("Expected review options.");
		}

		assert.equal(parsed.dryRun, true);
		assert.equal(parsed.forceReview, true);
		assert.equal(
			parsed.pullRequestUrl,
			"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123",
		);
		assert.equal(parsed.repoRoot, "/tmp/repo");
	});

	it("parses batch command options", () => {
		const parsed = parseCliArgs([
			"batch",
			"https://bitbucket.example.com/projects/PROJ/repos/my-repo",
			"--temp-root",
			"/tmp/batch",
			"--max-parallel",
			"3",
			"--keep-workdirs",
		]);

		assert.equal(isBatchCliOptions(parsed), true);
		if (!isBatchCliOptions(parsed)) {
			throw new Error("Expected batch options.");
		}

		assert.equal(
			parsed.repositoryUrl,
			"https://bitbucket.example.com/projects/PROJ/repos/my-repo",
		);
		assert.equal(parsed.tempRoot, "/tmp/batch");
		assert.equal(parsed.maxParallel, 3);
		assert.equal(parsed.keepWorkdirs, true);
	});

	it("returns help for top-level help", () => {
		const parsed = parseCliArgs(["--help"]);

		assert.deepEqual(parsed, { help: true });
	});

	it("returns help for command help", () => {
		const parsed = parseCliArgs(["review", "--help"]);

		assert.deepEqual(parsed, { help: true, commandName: "review" });
	});

	it("rejects option values that are actually another flag", () => {
		assert.throws(
			() => parseCliArgs(["review", "--repo-root", "--dry-run"]),
			/--repo-root requires a value/,
		);
	});

	it("rejects unknown commands with an actionable message", () => {
		assert.throws(
			() => parseCliArgs(["scan"]),
			/Unknown command: scan\. Expected 'review' or 'batch'\./,
		);
	});

	it("rejects invalid max-parallel values", () => {
		assert.throws(
			() =>
				parseCliArgs([
					"batch",
					"https://bitbucket.example.com/projects/PROJ/repos/my-repo",
					"--max-parallel",
					"zero",
				]),
			/--max-parallel must be a positive integer/,
		);
	});
});

describe("getHelpText", () => {
	it("renders subcommand-oriented help text", () => {
		const helpText = getHelpText();

		assert.match(
			helpText,
			/Usage: bitbucket-copilot-pr-review <command> \[options\]/,
		);
		assert.match(helpText, /Commands:/);
		assert.match(
			helpText,
			/bitbucket-copilot-pr-review review <pull-request-url> \[options\]/,
		);
		assert.match(
			helpText,
			/bitbucket-copilot-pr-review batch <repository-url> \[options\]/,
		);
		assert.match(helpText, /REVIEW/);
		assert.match(helpText, /BATCH/);
		assert.match(helpText, /Argument: <pull-request-url>/);
		assert.match(helpText, /Argument: <repository-url>/);
		assert.match(helpText, /--repo-root <path>/);
		assert.match(helpText, /--keep-workdirs/);
	});

	it("renders command-specific help for the review subcommand", () => {
		const helpText = getHelpText("review");

		assert.match(
			helpText,
			/Usage: bitbucket-copilot-pr-review review <pull-request-url> \[options\]/,
		);
		assert.doesNotMatch(helpText, /<repository-url>/);
		assert.match(helpText, /--repo-root <path>/);
		assert.match(helpText, /--confirm-rerun/);
	});
});

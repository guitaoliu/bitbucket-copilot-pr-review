import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GitReadTextFileResult, GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";
import {
	baseReviewerConfig,
	createPullRequest,
} from "../test-support/review-fixtures.ts";
import { buildReviewContext } from "./context.ts";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

function createGitStub(overrides: Partial<GitRepository> = {}): GitRepository {
	return {
		diff: async () =>
			[
				"diff --git a/src/example.ts b/src/example.ts",
				"index 1111111..2222222 100644",
				"--- a/src/example.ts",
				"+++ b/src/example.ts",
				"@@ -1,1 +1,1 @@",
				"-export const value = 1;",
				"+export const value = 2;",
			].join("\n"),
		listFilesAtCommit: async () => [],
		readTextFileAtCommit: async () =>
			({
				status: "not_found",
			}) as GitReadTextFileResult,
		...overrides,
	} as GitRepository;
}

describe("buildReviewContext", () => {
	it("does not read AGENTS instructions because the Copilot CLI uses the trusted base checkout", async () => {
		let readTextFileAtCommitCalls = 0;
		const git = createGitStub({
			readTextFileAtCommit: async () => {
				readTextFileAtCommitCalls += 1;
				return { status: "not_found" };
			},
		});

		const context = await buildReviewContext(
			{
				config: baseReviewerConfig,
				git,
				mergeBaseCommit: "merge-base-123",
			},
			logger,
			createPullRequest(),
		);

		assert.equal(readTextFileAtCommitCalls, 0);
		assert.equal(context.reviewedFiles[0]?.path, "src/example.ts");
	});
});

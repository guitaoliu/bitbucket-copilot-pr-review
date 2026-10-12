import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveReviewerConfig } from "../config/load.ts";
import type { OperatorConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";
import { baseReviewerConfig } from "../test-support/review-fixtures.ts";
import { loadTrustedRepoConfig } from "./repo-config.ts";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

const operatorConfig: OperatorConfig = {
	...baseReviewerConfig,
	copilot: { model: "env-model" },
	report: { ...baseReviewerConfig.report, title: undefined },
	review: {
		...baseReviewerConfig.review,
		ignorePaths: undefined,
		skipBranchPrefixes: undefined,
	},
};

function gitReturning(content: string | undefined): GitRepository {
	return {
		async readTextFileAtCommit(commit: string, filePath: string) {
			assert.equal(commit, "base-123");
			assert.equal(filePath, "copilot-code-review.json");
			return content === undefined
				? { status: "not_found" as const }
				: { status: "ok" as const, content };
		},
	} as unknown as GitRepository;
}

describe("loadTrustedRepoConfig", () => {
	it("applies the base-commit repo config below operator settings", async () => {
		const config = await loadTrustedRepoConfig(
			operatorConfig,
			gitReturning(
				'{"copilot":{"model":"repo-model","timeoutMs":600000},"review":{"ignorePaths":["i18n/**"],"skipBranchPrefixes":["deps/"]}}',
			),
			"base-123",
			logger,
		);

		assert.equal(config.copilot.model, "env-model");
		assert.equal(config.copilot.timeoutMs, 600000);
		assert.deepEqual(config.review.ignorePaths, ["i18n/**"]);
		assert.deepEqual(config.review.skipBranchPrefixes, ["deps/"]);
	});

	it("falls back to defaults when no trusted repo config exists", async () => {
		const config = await loadTrustedRepoConfig(
			operatorConfig,
			gitReturning(undefined),
			"base-123",
			logger,
		);

		assert.deepEqual(config, resolveReviewerConfig(operatorConfig));
		assert.deepEqual(config.review.skipBranchPrefixes, ["renovate/"]);
	});

	it("rejects an invalid trusted repo config with its commit location", async () => {
		await assert.rejects(
			loadTrustedRepoConfig(
				operatorConfig,
				gitReturning('{"copilot":{"timeoutMs":1}}'),
				"base-123",
				logger,
			),
			/Invalid base-123:copilot-code-review\.json:\ncopilot\.timeoutMs: copilot\.timeoutMs must be at least 60000\./,
		);
	});
});

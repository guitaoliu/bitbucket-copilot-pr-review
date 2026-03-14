import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";
import { loadTrustedRepoConfig } from "./repo-config.ts";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

const baseConfig: ReviewerConfig = {
	repoRoot: "/tmp/repo",
	gitRemoteName: "origin",
	logLevel: "info",
	bitbucket: {
		baseUrl: "https://bitbucket.example.com",
		projectKey: "PROJ",
		repoSlug: "repo",
		prId: 123,
		auth: { type: "bearer", token: "token" },
		tls: { insecureSkipVerify: false },
	},
	copilot: {
		model: "gpt-5.4",
		reasoningEffort: "xhigh",
		timeoutMs: 1800000,
	},
	report: {
		key: "copilot-review",
		title: "Copilot PR Review",
		reporter: "GitHub Copilot via Jenkins",
		commentTag: "copilot-pr-review",
		commentStrategy: "recreate",
	},
	review: {
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
		maxFiles: 200,
		maxFindings: 25,
		minConfidence: "medium",
		maxPatchChars: 12000,
		defaultFileSliceLines: 250,
		maxFileSliceLines: 400,
		ignorePaths: [],
	},
	internal: {
		explicitEnvOverrides: {
			copilot: { model: false, reasoningEffort: false, timeoutMs: false },
			report: { title: false, commentStrategy: false },
			review: {
				maxFiles: false,
				maxFindings: false,
				minConfidence: false,
				maxPatchChars: false,
				defaultFileSliceLines: false,
				maxFileSliceLines: false,
				ignorePaths: false,
			},
		},
	},
};

describe("loadTrustedRepoConfig", () => {
	it("loads trusted repo config from the base commit", async () => {
		const git = {
			async readFileAtCommit(commit: string, filePath: string) {
				assert.equal(commit, "base-123");
				assert.equal(filePath, "copilot-code-review.json");
				return '{"review":{"ignorePaths":["i18n/locales/**/*.json"],"maxFiles":150}}';
			},
		} as unknown as GitRepository;

		const config = await loadTrustedRepoConfig(
			baseConfig,
			git,
			"base-123",
			logger,
		);

		assert.equal(config.review.maxFiles, 150);
		assert.deepEqual(config.review.ignorePaths, ["i18n/locales/**/*.json"]);
		assert.deepEqual(config.internal?.trustedRepoConfig, {
			path: "copilot-code-review.json",
			commit: "base-123",
		});
	});

	it("returns the original config when no trusted repo config exists", async () => {
		const git = {
			async readFileAtCommit() {
				return undefined;
			},
		} as unknown as GitRepository;

		const config = await loadTrustedRepoConfig(
			baseConfig,
			git,
			"base-123",
			logger,
		);

		assert.equal(config, baseConfig);
	});
});

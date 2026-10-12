import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import type { ReviewCliOptions } from "./args.ts";
import { loadConfig, resolveReviewerConfig } from "./load.ts";
import { parseRepoReviewConfig } from "./repo-config.ts";
import type { ReviewerConfig } from "./types.ts";

const pullRequestUrl =
	"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123";

function cliOptions(
	overrides: Partial<ReviewCliOptions> = {},
): ReviewCliOptions {
	return {
		command: "review",
		pullRequestUrl,
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
		...overrides,
	};
}

function resolveFromEnv(
	env: NodeJS.ProcessEnv,
	repoConfigJson?: string,
): ReviewerConfig {
	const operatorConfig = loadConfig(cliOptions(), {
		BITBUCKET_TOKEN: "token",
		...env,
	});
	return resolveReviewerConfig(
		operatorConfig,
		repoConfigJson === undefined
			? undefined
			: parseRepoReviewConfig(repoConfigJson),
	);
}

describe("loadConfig", () => {
	it("resolves the pull request location, auth, and built-in defaults", () => {
		const config = resolveFromEnv({});

		assert.deepEqual(config.bitbucket, {
			baseUrl: "https://bitbucket.example.com",
			projectKey: "PROJ",
			repoSlug: "repo",
			prId: 123,
			auth: { type: "bearer", token: "token" },
			tls: { caCertPath: undefined, insecureSkipVerify: false },
		});
		assert.equal(config.repoRoot, process.cwd());
		assert.equal(config.gitRemoteName, "origin");
		assert.equal(config.logLevel, "info");
		assert.deepEqual(config.copilot, {
			model: "gpt-5.6-sol",
			reasoningEffort: "medium",
			timeoutMs: 1_800_000,
			runtimeLogDir: undefined,
		});
		assert.equal(config.report.key, "copilot-pr-review");
		assert.equal(config.report.title, "Copilot PR Review");
		assert.equal(config.report.commentStrategy, "recreate");
		assert.equal(config.review.minConfidence, "medium");
		assert.deepEqual(config.review.ignorePaths, []);
		assert.deepEqual(config.review.skipBranchPrefixes, ["renovate/"]);
		assert.equal(config.review.forceReview, false);
		assert.equal(config.review.confirmRerun, false);
	});

	it("leaves repo-overridable fields unset when the operator did not set them", () => {
		const operatorConfig = loadConfig(cliOptions(), {
			BITBUCKET_TOKEN: "token",
		});

		assert.deepEqual(operatorConfig.copilot, {
			model: undefined,
			reasoningEffort: undefined,
			timeoutMs: undefined,
			runtimeLogDir: undefined,
		});
		assert.equal(operatorConfig.report.title, undefined);
		assert.equal(operatorConfig.review.skipBranchPrefixes, undefined);
	});

	it("lets --repo-root win over REPO_ROOT and rejects unreadable roots", () => {
		const config = loadConfig(cliOptions({ repoRoot: "." }), {
			BITBUCKET_TOKEN: "token",
			REPO_ROOT: "/definitely/missing/root",
		});

		assert.equal(config.repoRoot, process.cwd());
		assert.throws(
			() =>
				loadConfig(cliOptions(), {
					BITBUCKET_TOKEN: "token",
					REPO_ROOT: "/definitely/missing/root",
				}),
			/Repository root is not readable: \/definitely\/missing\/root/,
		);
	});

	it("rejects an unreadable BITBUCKET_CA_CERT_PATH", () => {
		assert.throws(
			() =>
				loadConfig(cliOptions(), {
					BITBUCKET_TOKEN: "token",
					BITBUCKET_CA_CERT_PATH: "/definitely/missing/ca.pem",
				}),
			/BITBUCKET_CA_CERT_PATH is not readable: \/definitely\/missing\/ca\.pem/,
		);
	});

	it("resolves COPILOT_RUNTIME_LOG_DIR to an absolute path", () => {
		const config = resolveFromEnv({
			COPILOT_RUNTIME_LOG_DIR: "artifacts/copilot-logs",
		});

		assert.equal(
			config.copilot.runtimeLogDir,
			path.resolve("artifacts/copilot-logs"),
		);
		assert.throws(
			() => parseRepoReviewConfig('{"copilot":{"runtimeLogDir":"logs"}}'),
			/runtimeLogDir/,
		);
	});

	it("falls back to BUILD_URL for the report link", () => {
		assert.equal(
			resolveFromEnv({ BUILD_URL: "https://ci.example.com/build/1" }).report
				.link,
			"https://ci.example.com/build/1",
		);
		assert.equal(
			resolveFromEnv({
				REPORT_LINK: "https://ci.example.com/report",
				BUILD_URL: "https://ci.example.com/build/1",
			}).report.link,
			"https://ci.example.com/report",
		);
	});

	it("sanitizes report keys and shortens them to Bitbucket's limit", () => {
		const longKey = "com.github.copilot.bitbucket-pr-review.local.Guitao.Liu";

		assert.equal(
			resolveFromEnv({ REPORT_KEY: "local review / test" }).report.key,
			"local-review-test",
		);
		assert.equal(
			resolveFromEnv({ REPORT_KEY: "copilot-local-review" }).report.key,
			"copilot-local-review",
		);
		assert.equal(
			resolveFromEnv({ REPORT_KEY: "///" }).report.key,
			"copilot-pr-review",
		);
		const shortened = resolveFromEnv({ REPORT_KEY: longKey }).report.key;
		assert.equal(shortened.length, 50);
		assert.match(
			shortened,
			/^com\.github\.copilot\.bitbucket-pr-review\.-[0-9a-f]{10}$/,
		);
	});

	it("enables forced reviews from either REVIEW_FORCE or --force-review", () => {
		const fromEnv = loadConfig(cliOptions(), {
			BITBUCKET_TOKEN: "token",
			REVIEW_FORCE: "1",
		});
		const fromCli = loadConfig(cliOptions({ forceReview: true }), {
			BITBUCKET_TOKEN: "token",
			REVIEW_FORCE: "0",
		});

		assert.equal(fromEnv.review.forceReview, true);
		assert.equal(fromCli.review.forceReview, true);
	});

	it("does not bound env values by repo config limits", () => {
		const config = resolveFromEnv(
			{ COPILOT_TIMEOUT_MS: "30000", COPILOT_MODEL: "m".repeat(200) },
			'{"report":{"title":"Repo title"}}',
		);

		assert.equal(config.copilot.timeoutMs, 30000);
		assert.equal(config.copilot.model, "m".repeat(200));
		assert.equal(config.report.title, "Repo title");
	});
});

describe("resolveReviewerConfig precedence", () => {
	const repoConfigJson = `{
	  "copilot": { "model": "repo-model", "reasoningEffort": "high", "timeoutMs": 600000 },
	  "report": { "title": "Repo title", "commentStrategy": "update" },
	  "review": {
	    "minConfidence": "low",
	    "ignorePaths": ["generated/**"],
	    "skipBranchPrefixes": ["deps/"]
	  }
	}`;

	it("applies trusted repo config where the operator set nothing", () => {
		const config = resolveFromEnv({}, repoConfigJson);

		assert.deepEqual(config.copilot, {
			model: "repo-model",
			reasoningEffort: "high",
			timeoutMs: 600000,
			runtimeLogDir: undefined,
		});
		assert.equal(config.report.title, "Repo title");
		assert.equal(config.report.commentStrategy, "update");
		assert.equal(config.review.minConfidence, "low");
		assert.deepEqual(config.review.ignorePaths, ["generated/**"]);
		assert.deepEqual(config.review.skipBranchPrefixes, ["deps/"]);
	});

	it("never lets repo config override env values", () => {
		const config = resolveFromEnv(
			{
				COPILOT_MODEL: "env-model",
				COPILOT_REASONING_EFFORT: "max",
				COPILOT_TIMEOUT_MS: "120000",
				REPORT_TITLE: "Env title",
				REPORT_COMMENT_STRATEGY: "recreate",
				REVIEW_MIN_CONFIDENCE: "high",
				REVIEW_IGNORE_PATHS: "env-only/**",
				REVIEW_SKIP_BRANCH_PREFIXES: "env/",
			},
			repoConfigJson,
		);

		assert.deepEqual(config.copilot, {
			model: "env-model",
			reasoningEffort: "max",
			timeoutMs: 120000,
			runtimeLogDir: undefined,
		});
		assert.equal(config.report.title, "Env title");
		assert.equal(config.report.commentStrategy, "recreate");
		assert.equal(config.review.minConfidence, "high");
		assert.deepEqual(config.review.ignorePaths, ["env-only/**"]);
		assert.deepEqual(config.review.skipBranchPrefixes, ["env/"]);
	});

	it("lets a comma-only env list clear repo and default lists", () => {
		const withRepo = resolveFromEnv(
			{ REVIEW_IGNORE_PATHS: ",", REVIEW_SKIP_BRANCH_PREFIXES: " , " },
			repoConfigJson,
		);
		const withoutRepo = resolveFromEnv({ REVIEW_SKIP_BRANCH_PREFIXES: "," });

		assert.deepEqual(withRepo.review.ignorePaths, []);
		assert.deepEqual(withRepo.review.skipBranchPrefixes, []);
		assert.deepEqual(withoutRepo.review.skipBranchPrefixes, []);
	});

	it("treats a blank env list as unset so repo config and defaults still apply", () => {
		const withRepo = resolveFromEnv(
			{ REVIEW_SKIP_BRANCH_PREFIXES: "" },
			repoConfigJson,
		);
		const withoutRepo = resolveFromEnv({ REVIEW_SKIP_BRANCH_PREFIXES: "" });

		assert.deepEqual(withRepo.review.skipBranchPrefixes, ["deps/"]);
		assert.deepEqual(withoutRepo.review.skipBranchPrefixes, ["renovate/"]);
	});

	it("lets repo config clear the default skip branch prefixes", () => {
		const config = resolveFromEnv({}, '{"review":{"skipBranchPrefixes":[]}}');

		assert.deepEqual(config.review.skipBranchPrefixes, []);
	});

	it("ignores the deprecated repo maxFiles field", () => {
		const config = resolveFromEnv({}, '{"review":{"maxFiles":150}}');

		assert.equal("maxFiles" in config.review, false);
	});

	it("keeps CLI-only and non-overridable settings out of repo control", () => {
		const operatorConfig = loadConfig(
			cliOptions({ dryRun: true, confirmRerun: true }),
			{ BITBUCKET_TOKEN: "token", REPORT_KEY: "env-key" },
		);
		const config = resolveReviewerConfig(
			operatorConfig,
			parseRepoReviewConfig(repoConfigJson),
		);

		assert.equal(config.review.dryRun, true);
		assert.equal(config.review.confirmRerun, true);
		assert.equal(config.report.key, "env-key");
		assert.deepEqual(config.bitbucket, operatorConfig.bitbucket);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeReportKey } from "./env.ts";
import { loadConfig } from "./load.ts";
import { mergeRepoReviewConfig, parseRepoReviewConfig } from "./repo-config.ts";

describe("normalizeReportKey", () => {
	it("keeps short report keys unchanged", () => {
		assert.equal(
			normalizeReportKey("copilot-local-review"),
			"copilot-local-review",
		);
	});

	it("shortens long report keys to fit Bitbucket limits", () => {
		const normalized = normalizeReportKey(
			"com.github.copilot.bitbucket-pr-review.local.Guitao.Liu",
		);

		assert.ok(normalized.length <= 50);
		assert.match(normalized, /^[A-Za-z0-9._-]+$/);
		assert.notEqual(
			normalized,
			"com.github.copilot.bitbucket-pr-review.local.Guitao.Liu",
		);
	});

	it("sanitizes unsupported characters", () => {
		assert.equal(
			normalizeReportKey(" local review / test "),
			"local-review-test",
		);
	});
});

describe("loadConfig feature flags", () => {
	it("uses simplified defaults", () => {
		const config = loadConfig([], {
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
		});

		assert.equal(config.bitbucket.tls.insecureSkipVerify, true);
		assert.equal(config.report.key, "copilot-pr-review");
		assert.equal(config.report.commentStrategy, "recreate");
		assert.equal(config.review.forceReview, false);
		assert.equal(config.review.confirmRerun, false);
		assert.equal(config.review.maxFiles, 200);
		assert.equal(config.review.maxFindings, 25);
		assert.equal(config.review.minConfidence, "medium");
		assert.deepEqual(config.review.ignorePaths, []);
	});

	it("parses ignored review path globs from env", () => {
		const config = loadConfig([], {
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
			REVIEW_IGNORE_PATHS: "i18n/locales/**/*.json, docs/generated/**",
		});

		assert.deepEqual(config.review.ignorePaths, [
			"i18n/locales/**/*.json",
			"docs/generated/**",
		]);
	});

	it("allows overriding the pull request comment strategy from env", () => {
		const config = loadConfig([], {
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
			REPORT_COMMENT_STRATEGY: "update",
		});

		assert.equal(config.report.commentStrategy, "update");
	});

	it("allows forcing a rerun from env or CLI", () => {
		const fromEnv = loadConfig([], {
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
			REVIEW_FORCE: "1",
		});
		const fromCli = loadConfig(["--force-review"], {
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
		});

		assert.equal(fromEnv.review.forceReview, true);
		assert.equal(fromCli.review.forceReview, true);
	});

	it("allows enabling rerun confirmation from CLI", () => {
		const config = loadConfig(["--confirm-rerun"], {
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
		});

		assert.equal(config.review.confirmRerun, true);
	});

	it("lets explicit env values win over repo config overrides", () => {
		const config = loadConfig([], {
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
			REVIEW_MAX_FILES: "300",
			REVIEW_IGNORE_PATHS: "env-only/**",
			COPILOT_MODEL: "env-model",
		});

		const merged = mergeRepoReviewConfig(
			config,
			parseRepoReviewConfig(`{
			  "review": {
			    "maxFiles": 150,
			    "ignorePaths": ["i18n/locales/**/*.json"]
			  },
			  "copilot": {
			    "model": "repo-model"
			  }
			}`),
		);

		assert.equal(merged.review.maxFiles, 300);
		assert.deepEqual(merged.review.ignorePaths, ["env-only/**"]);
		assert.equal(merged.copilot.model, "env-model");
	});
});

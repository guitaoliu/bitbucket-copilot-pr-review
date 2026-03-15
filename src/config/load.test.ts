import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	resolveBitbucketAuth,
	resolveBitbucketConfig,
} from "./bitbucket-resolver.ts";
import { REVIEWER_CONFIG_DEFAULTS } from "./defaults.ts";
import {
	getEnvRepoOverrides,
	getRequiredEnvValue,
	normalizeReportKey,
	parseEnvironment,
} from "./env.ts";
import { loadConfig } from "./load.ts";
import { CONFIG_FIELD_METADATA } from "./metadata.ts";
import { mergeRepoReviewConfig, parseRepoReviewConfig } from "./repo-config.ts";
import { resolveRuntimeConfigGroups } from "./runtime-resolver.ts";

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

describe("parseEnvironment", () => {
	it("uses metadata-driven parsers for normalized strings and scalars", () => {
		const env = parseEnvironment({
			BITBUCKET_BASE_URL: "https://bitbucket.example.com///",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
			BITBUCKET_INSECURE_TLS: "false",
			LOG_LEVEL: "debug",
			REVIEW_IGNORE_PATHS: "a/**, b/**",
		});

		assert.equal(env.BITBUCKET_BASE_URL, "https://bitbucket.example.com");
		assert.equal(env.BITBUCKET_INSECURE_TLS, false);
		assert.equal(env.LOG_LEVEL, "debug");
		assert.deepEqual(env.REVIEW_IGNORE_PATHS, ["a/**", "b/**"]);
	});

	it("keeps metadata-backed enum validation errors", () => {
		assert.throws(
			() =>
				parseEnvironment({
					BITBUCKET_BASE_URL: "https://bitbucket.example.com",
					BITBUCKET_PROJECT_KEY: "PROJ",
					BITBUCKET_REPO_SLUG: "repo",
					BITBUCKET_PR_ID: "123",
					BITBUCKET_TOKEN: "token",
					LOG_LEVEL: "verbose",
				}),
			new RegExp(`${CONFIG_FIELD_METADATA.logLevel.env} must be one of:`),
		);
	});

	it("derives repo override values from metadata-marked env fields", () => {
		const env = parseEnvironment({
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
			COPILOT_MODEL: "env-model",
			REPORT_COMMENT_STRATEGY: "update",
			REVIEW_IGNORE_PATHS: "generated/**, docs/**",
		});

		assert.deepEqual(getEnvRepoOverrides(env), {
			copilot: {
				model: "env-model",
			},
			report: {
				commentStrategy: "update",
			},
			review: {
				ignorePaths: ["generated/**", "docs/**"],
			},
		});
	});

	it("uses metadata-backed required env lookup helper", () => {
		const env = parseEnvironment({
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
		});

		assert.equal(
			getRequiredEnvValue(env, "BITBUCKET_BASE_URL"),
			"https://bitbucket.example.com",
		);
	});
});

describe("resolveRuntimeConfigGroups", () => {
	it("resolves copilot report and review groups from metadata-driven sources", () => {
		const env = parseEnvironment({
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
			COPILOT_MODEL: "env-model",
			REPORT_KEY: " team/report ",
			BUILD_URL: "https://ci.example.com/build/1",
			REVIEW_MAX_FILES: "300",
		});

		const resolved = resolveRuntimeConfigGroups(env, {
			dryRun: false,
			forceReview: true,
			confirmRerun: false,
			help: false,
		});

		assert.equal(resolved.copilot.model, "env-model");
		assert.equal(
			resolved.bitbucket.tls.insecureSkipVerify,
			REVIEWER_CONFIG_DEFAULTS.bitbucket.tls.insecureSkipVerify,
		);
		assert.equal(resolved.report.key, "team-report");
		assert.equal(resolved.report.link, "https://ci.example.com/build/1");
		assert.equal(resolved.review.forceReview, true);
		assert.equal(resolved.review.maxFiles, 300);
		assert.equal(
			resolved.review.maxFindings,
			REVIEWER_CONFIG_DEFAULTS.review.maxFindings,
		);
		assert.equal(
			resolved.gitRemoteName,
			REVIEWER_CONFIG_DEFAULTS.gitRemoteName,
		);
		assert.equal(resolved.logLevel, REVIEWER_CONFIG_DEFAULTS.logLevel);
	});

	it("resolves bitbucket runtime fields from env with default fallback", () => {
		const env = parseEnvironment({
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
			BITBUCKET_INSECURE_TLS: "false",
		});

		const resolved = resolveRuntimeConfigGroups(env, {
			dryRun: false,
			forceReview: false,
			confirmRerun: false,
			help: false,
		});

		assert.equal(resolved.bitbucket.tls.insecureSkipVerify, false);
	});

	it("resolves top-level config from env and cli inputs", () => {
		const env = parseEnvironment({
			REPO_ROOT: ".",
			GIT_REMOTE_NAME: "upstream",
			LOG_LEVEL: "warn",
			CI_SUMMARY_PATH: "/tmp/summary.txt",
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
		});

		const resolved = resolveRuntimeConfigGroups(env, {
			dryRun: false,
			forceReview: false,
			confirmRerun: false,
			repoRoot: process.cwd(),
			help: false,
		});

		assert.equal(resolved.repoRoot, process.cwd());
		assert.equal(resolved.gitRemoteName, "upstream");
		assert.equal(resolved.logLevel, "warn");
		assert.equal(resolved.ciSummaryPath, "/tmp/summary.txt");
	});
});

describe("resolveBitbucketAuth", () => {
	it("resolves bearer auth from explicit auth type", () => {
		const env = parseEnvironment({
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_AUTH_TYPE: "bearer",
			BITBUCKET_TOKEN: "token",
		});

		assert.deepEqual(resolveBitbucketAuth(env), {
			type: "bearer",
			token: "token",
		});
	});

	it("resolves basic auth when username and password are provided", () => {
		const env = parseEnvironment({
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_USERNAME: "ci-user",
			BITBUCKET_PASSWORD: "secret",
		});

		assert.deepEqual(resolveBitbucketAuth(env), {
			type: "basic",
			username: "ci-user",
			password: "secret",
		});
	});
});

describe("resolveBitbucketConfig", () => {
	it("builds the full bitbucket config from env and runtime inputs", () => {
		const env = parseEnvironment({
			BITBUCKET_BASE_URL: "https://bitbucket.example.com",
			BITBUCKET_PROJECT_KEY: "PROJ",
			BITBUCKET_REPO_SLUG: "repo",
			BITBUCKET_PR_ID: "123",
			BITBUCKET_TOKEN: "token",
		});

		assert.deepEqual(
			resolveBitbucketConfig(
				env,
				{ tls: { insecureSkipVerify: true } },
				{ caCertPath: "/tmp/cert.pem" },
			),
			{
				baseUrl: "https://bitbucket.example.com",
				projectKey: "PROJ",
				repoSlug: "repo",
				prId: 123,
				auth: {
					type: "bearer",
					token: "token",
				},
				tls: {
					caCertPath: "/tmp/cert.pem",
					insecureSkipVerify: true,
				},
			},
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
		assert.equal(config.review.maxFiles, 300);
		assert.equal(config.review.maxFindings, 25);
		assert.equal(config.review.minConfidence, "medium");
		assert.deepEqual(config.review.ignorePaths, []);
		assert.equal(config.copilot.model, REVIEWER_CONFIG_DEFAULTS.copilot.model);
		assert.deepEqual(config.internal?.envRepoOverrides, {
			copilot: {},
			report: {},
			review: {},
		});
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
		assert.deepEqual(config.internal?.envRepoOverrides.review.ignorePaths, [
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
		assert.equal(
			config.internal?.envRepoOverrides.report.commentStrategy,
			"update",
		);
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

	it("lets env values win over repo config overrides", () => {
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

	it("uses metadata-backed required field errors", () => {
		assert.throws(
			() =>
				loadConfig([], {
					BITBUCKET_PROJECT_KEY: "PROJ",
					BITBUCKET_REPO_SLUG: "repo",
					BITBUCKET_PR_ID: "123",
					BITBUCKET_TOKEN: "token",
				}),
			new RegExp(
				`${CONFIG_FIELD_METADATA.bitbucketBaseUrl.env} is required\\.`,
			),
		);
	});
});

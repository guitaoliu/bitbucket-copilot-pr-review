import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	parseBitbucketPullRequestUrl,
	parseBitbucketRepositoryUrl,
	resolveBitbucketAuth,
	resolveBitbucketConfig,
} from "./bitbucket-resolver.ts";
import { REVIEWER_CONFIG_DEFAULTS } from "./defaults.ts";
import {
	getEnvRepoOverrides,
	normalizeReportKey,
	parseEnvironment,
} from "./env.ts";
import { loadBatchConfig, loadConfig } from "./load.ts";
import { CONFIG_FIELD_METADATA } from "./metadata.ts";
import { mergeRepoReviewConfig, parseRepoReviewConfig } from "./repo-config.ts";
import { resolveRuntimeConfigGroups } from "./runtime-resolver.ts";

const pullRequestUrl =
	"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123";
const repositoryUrl =
	"https://bitbucket.example.com/projects/PROJ/repos/my-repo";

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
			BITBUCKET_TOKEN: "token",
			BITBUCKET_INSECURE_TLS: "false",
			LOG_LEVEL: "debug",
			REVIEW_IGNORE_PATHS: "a/**, b/**",
		});

		assert.equal(env.BITBUCKET_INSECURE_TLS, false);
		assert.equal(env.LOG_LEVEL, "debug");
		assert.deepEqual(env.REVIEW_IGNORE_PATHS, ["a/**", "b/**"]);
	});

	it("keeps metadata-backed enum validation errors", () => {
		assert.throws(
			() =>
				parseEnvironment({
					BITBUCKET_TOKEN: "token",
					LOG_LEVEL: "verbose",
				}),
			new RegExp(`${CONFIG_FIELD_METADATA.logLevel.env} must be one of:`),
		);
	});

	it("derives repo override values from metadata-marked env fields", () => {
		const env = parseEnvironment({
			BITBUCKET_TOKEN: "token",
			COPILOT_MODEL: "env-model",
			REPORT_COMMENT_STRATEGY: "update",
			REVIEW_IGNORE_PATHS: "generated/**, docs/**",
			REVIEW_SKIP_BRANCH_PREFIXES: "renovate/, deps/",
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
				skipBranchPrefixes: ["renovate/", "deps/"],
			},
		});
	});

	it("allows clearing env-based list overrides with blank values", () => {
		const env = parseEnvironment({
			BITBUCKET_TOKEN: "token",
			REVIEW_IGNORE_PATHS: " , ",
			REVIEW_SKIP_BRANCH_PREFIXES: " , ",
		});

		assert.deepEqual(getEnvRepoOverrides(env), {
			copilot: {},
			report: {},
			review: {
				ignorePaths: [],
				skipBranchPrefixes: [],
			},
		});
	});

	it("applies repo-config bounds to env-based repo overrides", () => {
		assert.throws(
			() =>
				getEnvRepoOverrides(
					parseEnvironment({
						BITBUCKET_TOKEN: "token",
						REVIEW_MAX_FILES: "999999",
					}),
				),
			/Invalid environment repo overrides:\nreview\.maxFiles: review\.maxFiles must be at most 500\./,
		);

		assert.throws(
			() =>
				getEnvRepoOverrides(
					parseEnvironment({
						BITBUCKET_TOKEN: "token",
						COPILOT_TIMEOUT_MS: "999999999",
					}),
				),
			/copilot\.timeoutMs: copilot\.timeoutMs must be at most 3600000\./,
		);
	});
});

describe("parseBitbucketPullRequestUrl", () => {
	it("parses pull request urls with optional query and hash", () => {
		const parsed = parseBitbucketPullRequestUrl(
			`${pullRequestUrl}/?foo=1#activity`,
		);

		assert.deepEqual(parsed, {
			baseUrl: "https://bitbucket.example.com",
			projectKey: "PROJ",
			repoSlug: "repo",
			prId: 123,
			repositoryUrl: "https://bitbucket.example.com/projects/PROJ/repos/repo",
			pullRequestUrl,
		});
	});

	it("parses pull request urls under a path prefix", () => {
		const parsed = parseBitbucketPullRequestUrl(
			"https://host.example.com:8443/bitbucket/projects/PROJ/repos/repo/pull-requests/123",
		);

		assert.equal(parsed.baseUrl, "https://host.example.com:8443/bitbucket");
	});

	it("rejects non-pull-request urls", () => {
		assert.throws(
			() =>
				parseBitbucketPullRequestUrl(
					"https://bitbucket.example.com/projects/PROJ/repos/repo",
				),
			/Pull request URL must point to a pull request page/,
		);
	});
});

describe("parseBitbucketRepositoryUrl", () => {
	it("parses repository urls", () => {
		const parsed = parseBitbucketRepositoryUrl(
			`${repositoryUrl}/?foo=1#browse`,
		);

		assert.deepEqual(parsed, {
			baseUrl: "https://bitbucket.example.com",
			projectKey: "PROJ",
			repoSlug: "my-repo",
			repositoryUrl,
		});
	});

	it("rejects malformed repository urls", () => {
		assert.throws(
			() =>
				parseBitbucketRepositoryUrl(
					"https://bitbucket.example.com/projects/PROJ",
				),
			/Repository URL must point to a repository page/,
		);
	});
});

describe("resolveRuntimeConfigGroups", () => {
	it("resolves copilot report and review groups from metadata-driven sources", () => {
		const env = parseEnvironment({
			BITBUCKET_TOKEN: "token",
			COPILOT_MODEL: "env-model",
			REPORT_KEY: " team/report ",
			BUILD_URL: "https://ci.example.com/build/1",
			REVIEW_MAX_FILES: "300",
		});

		const resolved = resolveRuntimeConfigGroups(env, {
			command: "review",
			pullRequestUrl,
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
	});

	it("resolves bitbucket runtime fields from env with default fallback", () => {
		const env = parseEnvironment({
			BITBUCKET_TOKEN: "token",
			BITBUCKET_INSECURE_TLS: "false",
		});

		const resolved = resolveRuntimeConfigGroups(env, {
			command: "review",
			pullRequestUrl,
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
			BITBUCKET_TOKEN: "token",
		});

		const resolved = resolveRuntimeConfigGroups(env, {
			command: "review",
			pullRequestUrl,
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
	it("builds the full bitbucket config from resolved identity and env", () => {
		const env = parseEnvironment({
			BITBUCKET_TOKEN: "token",
		});

		assert.deepEqual(
			resolveBitbucketConfig({
				location: parseBitbucketPullRequestUrl(pullRequestUrl),
				env,
				runtimeConfig: { tls: { insecureSkipVerify: true } },
				caCertPath: "/tmp/cert.pem",
			}),
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
		const config = loadConfig(["review", pullRequestUrl], {
			BITBUCKET_TOKEN: "token",
		});

		assert.equal(config.bitbucket.baseUrl, "https://bitbucket.example.com");
		assert.equal(config.bitbucket.projectKey, "PROJ");
		assert.equal(config.bitbucket.repoSlug, "repo");
		assert.equal(config.bitbucket.prId, 123);
		assert.equal(config.bitbucket.tls.insecureSkipVerify, false);
		assert.equal(config.report.key, "copilot-pr-review");
		assert.equal(config.review.forceReview, false);
		assert.equal(config.review.confirmRerun, false);
		assert.equal(config.review.maxFiles, 300);
	});

	it("keeps strict TLS enabled by default in batch mode", () => {
		const config = loadBatchConfig(["batch", repositoryUrl], {
			BITBUCKET_TOKEN: "token",
		});

		assert.equal(config.bitbucket.tls.insecureSkipVerify, false);
	});

	it("parses ignored review path globs from env", () => {
		const config = loadConfig(["review", pullRequestUrl], {
			BITBUCKET_TOKEN: "token",
			REVIEW_IGNORE_PATHS: "i18n/locales/**/*.json, docs/generated/**",
			REVIEW_SKIP_BRANCH_PREFIXES: "renovate/, deps/",
		});

		assert.deepEqual(config.review.ignorePaths, [
			"i18n/locales/**/*.json",
			"docs/generated/**",
		]);
		assert.deepEqual(config.review.skipBranchPrefixes, ["renovate/", "deps/"]);
	});

	it("allows overriding the pull request comment strategy from env", () => {
		const config = loadConfig(["review", pullRequestUrl], {
			BITBUCKET_TOKEN: "token",
			REPORT_COMMENT_STRATEGY: "update",
		});

		assert.equal(config.report.commentStrategy, "update");
	});

	it("allows forcing a rerun from env or CLI", () => {
		const fromEnv = loadConfig(["review", pullRequestUrl], {
			BITBUCKET_TOKEN: "token",
			REVIEW_FORCE: "1",
		});
		const fromCli = loadConfig(["review", pullRequestUrl, "--force-review"], {
			BITBUCKET_TOKEN: "token",
		});

		assert.equal(fromEnv.review.forceReview, true);
		assert.equal(fromCli.review.forceReview, true);
	});

	it("allows enabling rerun confirmation from CLI", () => {
		const config = loadConfig(["review", pullRequestUrl, "--confirm-rerun"], {
			BITBUCKET_TOKEN: "token",
		});

		assert.equal(config.review.confirmRerun, true);
	});

	it("lets env values win over repo config overrides", () => {
		const config = loadConfig(["review", pullRequestUrl], {
			BITBUCKET_TOKEN: "token",
			REVIEW_MAX_FILES: "300",
			REVIEW_IGNORE_PATHS: "env-only/**",
			REVIEW_SKIP_BRANCH_PREFIXES: "env/",
			COPILOT_MODEL: "env-model",
		});

		const merged = mergeRepoReviewConfig(
			config,
			parseRepoReviewConfig(`{
			  "review": {
			    "maxFiles": 150,
			    "ignorePaths": ["i18n/locales/**/*.json"],
			    "skipBranchPrefixes": ["renovate/", "deps/"]
			  },
			  "copilot": {
			    "model": "repo-model"
			  }
			}`),
		);

		assert.equal(merged.review.maxFiles, 300);
		assert.deepEqual(merged.review.ignorePaths, ["env-only/**"]);
		assert.deepEqual(merged.review.skipBranchPrefixes, ["env/"]);
		assert.equal(merged.copilot.model, "env-model");
	});

	it("lets env values clear repo-configured list overrides", () => {
		const config = loadConfig(["review", pullRequestUrl], {
			BITBUCKET_TOKEN: "token",
			REVIEW_IGNORE_PATHS: " , ",
			REVIEW_SKIP_BRANCH_PREFIXES: " , ",
		});

		const merged = mergeRepoReviewConfig(
			config,
			parseRepoReviewConfig(`{
			  "review": {
			    "ignorePaths": ["generated/**"],
			    "skipBranchPrefixes": ["renovate/", "deps/"]
			  }
			}`),
		);

		assert.deepEqual(merged.review.ignorePaths, []);
		assert.deepEqual(merged.review.skipBranchPrefixes, []);
	});

	it("requires Bitbucket authentication envs", () => {
		assert.throws(
			() => loadConfig(["review", pullRequestUrl], {}),
			/Provide BITBUCKET_TOKEN or BITBUCKET_USERNAME and BITBUCKET_PASSWORD/,
		);
	});
});

describe("loadBatchConfig", () => {
	it("builds batch review config from repository url and env", () => {
		const config = loadBatchConfig(
			["batch", repositoryUrl, "--max-parallel", "4"],
			{
				BITBUCKET_TOKEN: "token",
				GIT_REMOTE_NAME: "upstream",
				LOG_LEVEL: "debug",
				REVIEW_FORCE: "1",
			},
		);

		assert.equal(config.repoId, "PROJ/my-repo");
		assert.equal(config.repositoryUrl, repositoryUrl);
		assert.equal(config.bitbucket.baseUrl, "https://bitbucket.example.com");
		assert.equal(config.bitbucket.projectKey, "PROJ");
		assert.equal(config.bitbucket.repoSlug, "my-repo");
		assert.equal(config.maxParallel, 4);
		assert.equal(config.gitRemoteName, "upstream");
		assert.equal(config.logLevel, "debug");
		assert.equal(config.review.forceReview, true);
	});

	it("reads batch skip branch prefixes from env", () => {
		const config = loadBatchConfig(["batch", repositoryUrl], {
			BITBUCKET_TOKEN: "token",
			REVIEW_SKIP_BRANCH_PREFIXES: "renovate/, deps/",
		});

		assert.deepEqual(config.review.skipBranchPrefixes, ["renovate/", "deps/"]);
	});

	it("lets batch env clear default skip branch prefixes", () => {
		const config = loadBatchConfig(["batch", repositoryUrl], {
			BITBUCKET_TOKEN: "token",
			REVIEW_SKIP_BRANCH_PREFIXES: " , ",
		});

		assert.deepEqual(config.review.skipBranchPrefixes, []);
	});

	it("rejects batch-only command invocations without a repository url", () => {
		assert.throws(
			() =>
				loadBatchConfig(["batch", "--max-parallel", "2"], {
					BITBUCKET_TOKEN: "token",
				}),
			/batch requires <repository-url>/,
		);
	});

	it("rejects malformed repository urls", () => {
		assert.throws(
			() =>
				loadBatchConfig(
					["batch", "https://bitbucket.example.com/projects/PROJ"],
					{
						BITBUCKET_TOKEN: "token",
					},
				),
			/Repository URL must point to a repository page/,
		);
	});
});

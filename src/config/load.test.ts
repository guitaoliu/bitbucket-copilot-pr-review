import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	parseBitbucketPullRequestUrl,
	resolveBitbucketConfig,
} from "./bitbucket-resolver.ts";
import { REVIEWER_CONFIG_DEFAULTS } from "./defaults.ts";
import {
	getEnvRepoOverrides,
	normalizeReportKey,
	parseEnvironment,
} from "./env.ts";
import { loadConfig } from "./load.ts";
import { CONFIG_FIELD_METADATA } from "./metadata.ts";
import { mergeRepoReviewConfig, parseRepoReviewConfig } from "./repo-config.ts";
import { resolveRuntimeConfigGroups } from "./runtime-resolver.ts";

const pullRequestUrl =
	"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123";

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

	it("normalizes GH_HOST from a GitHub Enterprise Cloud URL", () => {
		const env = parseEnvironment({
			BITBUCKET_TOKEN: "token",
			GH_HOST: "https://tenant.ghe.com",
		});

		assert.equal(env.GH_HOST, "tenant.ghe.com");
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

	it("rejects malformed GH_HOST values", () => {
		assert.throws(
			() =>
				parseEnvironment({
					BITBUCKET_TOKEN: "token",
					GH_HOST: "tenant.ghe.com/settings",
				}),
			/without any path, query, or hash/,
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

	it("parses pull request urls from Bitbucket PR tabs", () => {
		const tabUrls = [
			"https://bitbucket.example.com:8443/projects/PROJ/repos/repo/pull-requests/13616/overview",
			"https://bitbucket.example.com:8443/projects/PROJ/repos/repo/pull-requests/13616/diff#src%2Fcomponents%2FPermissionsEditor.tsx",
			"https://bitbucket.example.com:8443/projects/PROJ/repos/repo/pull-requests/13616/commits",
			"https://bitbucket.example.com:8443/projects/PROJ/repos/repo/pull-requests/13616/builds",
		];

		for (const tabUrl of tabUrls) {
			assert.deepEqual(parseBitbucketPullRequestUrl(tabUrl), {
				baseUrl: "https://bitbucket.example.com:8443",
				projectKey: "PROJ",
				repoSlug: "repo",
				prId: 13616,
				repositoryUrl:
					"https://bitbucket.example.com:8443/projects/PROJ/repos/repo",
				pullRequestUrl:
					"https://bitbucket.example.com:8443/projects/PROJ/repos/repo/pull-requests/13616",
			});
		}
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

describe("resolveRuntimeConfigGroups", () => {
	it("resolves copilot report and review groups from metadata-driven sources", () => {
		const env = parseEnvironment({
			BITBUCKET_TOKEN: "token",
			COPILOT_MODEL: "env-model",
			REPORT_KEY: " team/report ",
			BUILD_URL: "https://ci.example.com/build/1",
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

	it("resolves GH_HOST as a top-level runtime setting", () => {
		const env = parseEnvironment({
			BITBUCKET_TOKEN: "token",
			GH_HOST: "tenant.ghe.com",
		});

		const resolved = resolveRuntimeConfigGroups(env, {
			command: "review",
			pullRequestUrl,
			dryRun: false,
			forceReview: false,
			confirmRerun: false,
			help: false,
		});

		assert.equal(resolved.githubHost, "tenant.ghe.com");
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
		assert.equal(config.copilot.model, "gpt-5.6-terra");
		assert.equal(config.report.key, "copilot-pr-review");
		assert.equal(config.review.forceReview, false);
		assert.equal(config.review.confirmRerun, false);
	});

	it("loads GH_HOST into the direct review config", () => {
		const config = loadConfig(["review", pullRequestUrl], {
			BITBUCKET_TOKEN: "token",
			GH_HOST: "tenant.ghe.com",
		});

		assert.equal(config.githubHost, "tenant.ghe.com");
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
			REVIEW_IGNORE_PATHS: "env-only/**",
			REVIEW_SKIP_BRANCH_PREFIXES: "env/",
			COPILOT_MODEL: "env-model",
		});

		const merged = mergeRepoReviewConfig(
			config,
			parseRepoReviewConfig(`{
			  "review": {
			    "ignorePaths": ["i18n/locales/**/*.json"],
			    "skipBranchPrefixes": ["renovate/", "deps/"]
			  },
			  "copilot": {
			    "model": "repo-model"
			  }
			}`),
		);

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

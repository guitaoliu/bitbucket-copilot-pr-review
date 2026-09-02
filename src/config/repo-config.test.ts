import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG_FIELD_METADATA, isRepoOverrideField } from "./metadata.ts";
import {
	getRepoReviewConfigSchema,
	mergeRepoReviewConfig,
	parseRepoReviewConfig,
} from "./repo-config.ts";
import type { ReviewerConfig } from "./types.ts";

function getSchemaProperty(schema: unknown, path: readonly string[]): unknown {
	let current = schema;

	for (const segment of path) {
		if (typeof current !== "object" || current === null) {
			return undefined;
		}

		const properties = (current as { properties?: Record<string, unknown> })
			.properties;
		if (properties === undefined || !(segment in properties)) {
			return undefined;
		}

		current = properties[segment];
	}

	return current;
}

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
		tls: { insecureSkipVerify: true },
	},
	copilot: {
		model: "gpt-5.3-codex",
		reasoningEffort: "xhigh",
		timeoutMs: 1800000,
	},
	report: {
		key: "copilot-pr-review",
		title: "Copilot PR Review",
		reporter: "GitHub Copilot",
		commentTag: "copilot-pr-review",
		commentStrategy: "recreate",
	},
	review: {
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
		minConfidence: "medium",
		ignorePaths: [],
		skipBranchPrefixes: ["renovate/"],
	},
	internal: {
		envRepoOverrides: {
			copilot: {},
			report: {},
			review: {},
		},
	},
};

describe("parseRepoReviewConfig", () => {
	it("parses review ignore paths and optional overrides", () => {
		const config = parseRepoReviewConfig(`{
		  "$schema": "./schemas/copilot-code-review.schema.json",
		  "review": {
		    "ignorePaths": ["i18n/locales/**/*.json"],
		    "skipBranchPrefixes": ["renovate/", "deps/"]
			  },
			  "copilot": {
			    "model": "gpt-5.3-codex",
			    "reasoningEffort": "max"
			  }
			}`);

		assert.deepEqual(config.review?.ignorePaths, ["i18n/locales/**/*.json"]);
		assert.deepEqual(config.review?.skipBranchPrefixes, ["renovate/", "deps/"]);
		assert.equal(config.copilot?.model, "gpt-5.3-codex");
		assert.equal(config.copilot?.reasoningEffort, "max");
	});

	it("rejects unknown keys", () => {
		assert.throws(
			() => parseRepoReviewConfig('{"review":{"badKey":true}}'),
			/unrecognized key/i,
		);
	});

	it("accepts but ignores the legacy review maxFiles field", () => {
		const repoConfig = parseRepoReviewConfig('{"review":{"maxFiles":150}}');
		const merged = mergeRepoReviewConfig(baseConfig, repoConfig);

		assert.equal(repoConfig.review?.maxFiles, 150);
		assert.equal("maxFiles" in merged.review, false);
	});

	it("rejects removed review limit fields", () => {
		for (const field of [
			"maxFindings",
			"maxPatchChars",
			"defaultFileSliceLines",
			"maxFileSliceLines",
		]) {
			assert.throws(
				() => parseRepoReviewConfig(`{"review":{"${field}":10}}`),
				/unrecognized key/i,
			);
		}
	});

	it("rejects unreasonable numeric values", () => {
		assert.throws(
			() => parseRepoReviewConfig('{"copilot":{"timeoutMs":999999999}}'),
			/at most 7200000/,
		);
	});

	it("rejects overly long report titles and ignore path entries", () => {
		assert.throws(
			() =>
				parseRepoReviewConfig(
					JSON.stringify({ report: { title: "x".repeat(121) } }),
				),
			/at most 120 characters/,
		);
		assert.throws(
			() =>
				parseRepoReviewConfig(
					JSON.stringify({ review: { ignorePaths: ["x".repeat(513)] } }),
				),
			/at most 512 characters/,
		);
		assert.throws(
			() =>
				parseRepoReviewConfig(
					JSON.stringify({
						review: { skipBranchPrefixes: ["x".repeat(129)] },
					}),
				),
			/at most 128 characters/,
		);
	});

	it("allows clearing list-based review overrides with empty arrays", () => {
		const config = parseRepoReviewConfig(`{
		  "review": {
		    "ignorePaths": [],
		    "skipBranchPrefixes": []
		  }
		}`);

		assert.deepEqual(config.review?.ignorePaths, []);
		assert.deepEqual(config.review?.skipBranchPrefixes, []);
	});
});

describe("mergeRepoReviewConfig", () => {
	it("applies repo config when env did not explicitly override the field", () => {
		const merged = mergeRepoReviewConfig(
			baseConfig,
			parseRepoReviewConfig(`{
			  "review": {
			    "ignorePaths": ["i18n/locales/**/*.json"]
			  },
			  "report": {
			    "commentStrategy": "update"
			  }
			}`),
		);

		assert.deepEqual(merged.review.ignorePaths, ["i18n/locales/**/*.json"]);
		assert.equal(merged.report.commentStrategy, "update");
	});

	it("applies repo-configured skip branch prefixes", () => {
		const merged = mergeRepoReviewConfig(
			baseConfig,
			parseRepoReviewConfig(`{
			  "review": {
			    "skipBranchPrefixes": ["renovate/", "deps/"]
			  }
			}`),
		);

		assert.deepEqual(merged.review.skipBranchPrefixes, ["renovate/", "deps/"]);
	});

	it("lets repo config clear default skip branch prefixes", () => {
		const merged = mergeRepoReviewConfig(
			baseConfig,
			parseRepoReviewConfig('{"review":{"skipBranchPrefixes":[]}}'),
		);

		assert.deepEqual(merged.review.skipBranchPrefixes, []);
	});

	it("preserves explicit env overrides over repo config", () => {
		const merged = mergeRepoReviewConfig(
			{
				...baseConfig,
				copilot: {
					...baseConfig.copilot,
					model: "env-model",
				},
				internal: {
					envRepoOverrides: {
						copilot: {
							...baseConfig.internal?.envRepoOverrides.copilot,
							model: "env-model",
						},
						report: { ...baseConfig.internal?.envRepoOverrides.report },
						review: { ...baseConfig.internal?.envRepoOverrides.review },
					},
				},
			},
			parseRepoReviewConfig('{"copilot":{"model":"repo-model"}}'),
		);

		assert.equal(merged.copilot.model, "env-model");
		assert.deepEqual(merged.review.skipBranchPrefixes, ["renovate/"]);
	});

	it("preserves explicit env skip branch prefixes over repo config", () => {
		const merged = mergeRepoReviewConfig(
			{
				...baseConfig,
				review: {
					...baseConfig.review,
					skipBranchPrefixes: ["env/"],
				},
				internal: {
					envRepoOverrides: {
						copilot: {},
						report: {},
						review: {
							skipBranchPrefixes: ["env/"],
						},
					},
				},
			},
			parseRepoReviewConfig(
				'{"review":{"skipBranchPrefixes":["renovate/","deps/"]}}',
			),
		);

		assert.deepEqual(merged.review.skipBranchPrefixes, ["env/"]);
	});
});

describe("getRepoReviewConfigSchema", () => {
	it("includes review ignore path and skip branch support in the JSON schema", () => {
		const schema = getRepoReviewConfigSchema() as {
			properties?: {
				copilot?: { properties?: { timeoutMs?: { maximum?: number } } };
				report?: { properties?: { title?: { maxLength?: number } } };
				review?: {
					properties?: {
						ignorePaths?: {
							minItems?: number;
							maxItems?: number;
							items?: { maxLength?: number };
						};
						skipBranchPrefixes?: {
							minItems?: number;
							maxItems?: number;
							items?: { maxLength?: number };
						};
					};
				};
			};
		};

		assert.ok(schema.properties?.review?.properties?.ignorePaths);
		assert.equal(
			schema.properties?.copilot?.properties?.timeoutMs?.maximum,
			7200000,
		);
		assert.equal(schema.properties?.report?.properties?.title?.maxLength, 120);
		assert.equal(
			schema.properties?.review?.properties?.ignorePaths?.maxItems,
			200,
		);
		assert.equal(
			schema.properties?.review?.properties?.ignorePaths?.items?.maxLength,
			512,
		);
		assert.equal(
			schema.properties?.review?.properties?.skipBranchPrefixes?.maxItems,
			50,
		);
		assert.equal(
			schema.properties?.review?.properties?.skipBranchPrefixes?.items
				?.maxLength,
			128,
		);
		assert.equal(
			schema.properties?.review?.properties?.ignorePaths?.minItems,
			undefined,
		);
		assert.equal(
			schema.properties?.review?.properties?.skipBranchPrefixes?.minItems,
			undefined,
		);
	});

	it("covers every metadata-marked repo override field", () => {
		const schema = getRepoReviewConfigSchema();
		const repoOverridePaths = Object.values(CONFIG_FIELD_METADATA)
			.filter(isRepoOverrideField)
			.map((field) => field.path);

		assert.ok(repoOverridePaths.length > 0);

		for (const path of repoOverridePaths) {
			assert.ok(
				getSchemaProperty(schema, path.split(".")) !== undefined,
				`Missing repo config schema coverage for ${path}`,
			);
		}
	});
});

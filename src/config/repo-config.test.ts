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
		model: "gpt-5.4",
		reasoningEffort: "xhigh",
		timeoutMs: 1800000,
	},
	report: {
		key: "copilot-pr-review",
		title: "Copilot PR Review",
		reporter: "GitHub Copilot via Jenkins",
		commentTag: "copilot-pr-review",
		commentStrategy: "recreate",
	},
	review: {
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
		maxFiles: 300,
		maxFindings: 25,
		minConfidence: "medium",
		maxPatchChars: 12000,
		defaultFileSliceLines: 250,
		maxFileSliceLines: 400,
		ignorePaths: [],
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
		    "maxFiles": 150
		  },
		  "copilot": {
		    "model": "gpt-5.4"
		  }
		}`);

		assert.deepEqual(config.review?.ignorePaths, ["i18n/locales/**/*.json"]);
		assert.equal(config.review?.maxFiles, 150);
		assert.equal(config.copilot?.model, "gpt-5.4");
	});

	it("rejects unknown keys", () => {
		assert.throws(
			() => parseRepoReviewConfig('{"review":{"badKey":true}}'),
			/unrecognized key/i,
		);
	});

	it("rejects unreasonable numeric values", () => {
		assert.throws(
			() => parseRepoReviewConfig('{"copilot":{"timeoutMs":999999999}}'),
			/at most 3600000/,
		);
		assert.throws(
			() => parseRepoReviewConfig('{"review":{"maxFiles":999999}}'),
			/at most 500/,
		);
		assert.throws(
			() => parseRepoReviewConfig('{"review":{"maxPatchChars":10}}'),
			/at least 500/,
		);
	});

	it("rejects inconsistent file slice settings", () => {
		assert.throws(
			() =>
				parseRepoReviewConfig(
					'{"review":{"defaultFileSliceLines":500,"maxFileSliceLines":100}}',
				),
			/defaultFileSliceLines must be less than or equal to review\.maxFileSliceLines/,
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
	});
});

describe("mergeRepoReviewConfig", () => {
	it("applies repo config when env did not explicitly override the field", () => {
		const merged = mergeRepoReviewConfig(
			baseConfig,
			parseRepoReviewConfig(`{
			  "review": {
			    "ignorePaths": ["i18n/locales/**/*.json"],
			    "maxFiles": 150
			  },
			  "report": {
			    "commentStrategy": "update"
			  }
			}`),
		);

		assert.equal(merged.review.maxFiles, 150);
		assert.deepEqual(merged.review.ignorePaths, ["i18n/locales/**/*.json"]);
		assert.equal(merged.report.commentStrategy, "update");
	});

	it("preserves explicit env overrides over repo config", () => {
		const merged = mergeRepoReviewConfig(
			{
				...baseConfig,
				review: {
					...baseConfig.review,
					maxFiles: 300,
				},
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
						review: {
							...baseConfig.internal?.envRepoOverrides.review,
							maxFiles: 300,
						},
					},
				},
			},
			parseRepoReviewConfig(
				'{"review":{"maxFiles":150},"copilot":{"model":"repo-model"}}',
			),
		);

		assert.equal(merged.review.maxFiles, 300);
		assert.equal(merged.copilot.model, "env-model");
	});
});

describe("getRepoReviewConfigSchema", () => {
	it("includes review ignore path support in the JSON schema", () => {
		const schema = getRepoReviewConfigSchema() as {
			properties?: {
				copilot?: { properties?: { timeoutMs?: { maximum?: number } } };
				report?: { properties?: { title?: { maxLength?: number } } };
				review?: {
					properties?: {
						ignorePaths?: { maxItems?: number; items?: { maxLength?: number } };
						maxFiles?: { maximum?: number };
					};
				};
			};
		};

		assert.ok(schema.properties?.review?.properties?.ignorePaths);
		assert.equal(
			schema.properties?.copilot?.properties?.timeoutMs?.maximum,
			3600000,
		);
		assert.equal(schema.properties?.review?.properties?.maxFiles?.maximum, 500);
		assert.equal(schema.properties?.report?.properties?.title?.maxLength, 120);
		assert.equal(
			schema.properties?.review?.properties?.ignorePaths?.maxItems,
			200,
		);
		assert.equal(
			schema.properties?.review?.properties?.ignorePaths?.items?.maxLength,
			512,
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

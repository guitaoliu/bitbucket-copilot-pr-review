import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	getRepoReviewConfigSchema,
	mergeRepoReviewConfig,
	parseRepoReviewConfig,
} from "./repo-config.ts";
import type { ReviewerConfig } from "./types.ts";

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
				internal: {
					explicitEnvOverrides: {
						...baseConfig.internal?.explicitEnvOverrides,
						review: {
							...baseConfig.internal?.explicitEnvOverrides.review,
							maxFiles: true,
						},
					},
				},
			},
			parseRepoReviewConfig('{"review":{"maxFiles":150}}'),
		);

		assert.equal(merged.review.maxFiles, 300);
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
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	getRepoReviewConfigSchema,
	parseRepoReviewConfig,
} from "./repo-config.ts";

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
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseEnvironment } from "./env.ts";

describe("parseEnvironment", () => {
	it("parses trimmed strings, booleans, enums, and comma-separated lists", () => {
		const env = parseEnvironment({
			BITBUCKET_TOKEN: " token ",
			BITBUCKET_INSECURE_TLS: "off",
			LOG_LEVEL: "debug",
			COPILOT_TIMEOUT_MS: "30000",
			REVIEW_IGNORE_PATHS: "a/**, b/**",
		});

		assert.deepEqual(env.auth, { type: "bearer", token: "token" });
		assert.equal(env.BITBUCKET_INSECURE_TLS, false);
		assert.equal(env.LOG_LEVEL, "debug");
		assert.equal(env.COPILOT_TIMEOUT_MS, 30000);
		assert.deepEqual(env.REVIEW_IGNORE_PATHS, ["a/**", "b/**"]);
	});

	it("treats a comma-only list as an explicit empty list but a blank list as unset", () => {
		const cleared = parseEnvironment({
			BITBUCKET_TOKEN: "token",
			REVIEW_SKIP_BRANCH_PREFIXES: " , ",
		});
		const unset = parseEnvironment({
			BITBUCKET_TOKEN: "token",
			REVIEW_SKIP_BRANCH_PREFIXES: "  ",
		});

		assert.deepEqual(cleared.REVIEW_SKIP_BRANCH_PREFIXES, []);
		assert.equal(unset.REVIEW_SKIP_BRANCH_PREFIXES, undefined);
	});

	it("normalizes GH_HOST from a GitHub Enterprise Cloud URL", () => {
		const env = parseEnvironment({
			BITBUCKET_TOKEN: "token",
			GH_HOST: "https://tenant.ghe.com",
		});

		assert.equal(env.GH_HOST, "tenant.ghe.com");
	});

	it("reports every invalid variable by name", () => {
		assert.throws(
			() =>
				parseEnvironment({
					BITBUCKET_TOKEN: "token",
					LOG_LEVEL: "verbose",
					COPILOT_TIMEOUT_MS: "-5",
					REVIEW_FORCE: "maybe",
					GH_HOST: "tenant.ghe.com/settings",
				}),
			(error: Error) => {
				assert.match(error.message, /LOG_LEVEL must be one of: debug/);
				assert.match(
					error.message,
					/COPILOT_TIMEOUT_MS must be a positive integer\./,
				);
				assert.match(error.message, /REVIEW_FORCE must be a boolean value/);
				assert.match(error.message, /without any path, query, or hash/);
				return true;
			},
		);
	});
});

describe("parseEnvironment Bitbucket auth", () => {
	it("prefers a bearer token when the auth type is not set", () => {
		const env = parseEnvironment({
			BITBUCKET_TOKEN: "token",
			BITBUCKET_USERNAME: "user",
		});

		assert.deepEqual(env.auth, { type: "bearer", token: "token" });
	});

	it("uses basic auth when only username and password are set", () => {
		const env = parseEnvironment({
			BITBUCKET_USERNAME: "user",
			BITBUCKET_PASSWORD: "secret",
		});

		assert.deepEqual(env.auth, {
			type: "basic",
			username: "user",
			password: "secret",
		});
	});

	it("honors an explicit basic auth type over a configured token", () => {
		assert.throws(
			() =>
				parseEnvironment({
					BITBUCKET_AUTH_TYPE: "basic",
					BITBUCKET_TOKEN: "token",
				}),
			/BITBUCKET_USERNAME is required when BITBUCKET_AUTH_TYPE=basic\.\nBITBUCKET_PASSWORD is required when BITBUCKET_AUTH_TYPE=basic\./,
		);
	});

	it("requires a token for explicit bearer auth", () => {
		assert.throws(
			() =>
				parseEnvironment({
					BITBUCKET_AUTH_TYPE: "bearer",
					BITBUCKET_USERNAME: "user",
					BITBUCKET_PASSWORD: "secret",
				}),
			/BITBUCKET_TOKEN is required when BITBUCKET_AUTH_TYPE=bearer\./,
		);
	});

	it("requires both basic auth credentials once one is provided", () => {
		assert.throws(() => parseEnvironment({ BITBUCKET_USERNAME: "user" }), {
			message:
				"BITBUCKET_PASSWORD is required when using basic Bitbucket authentication.",
		});
	});

	it("requires some Bitbucket credentials", () => {
		assert.throws(
			() => parseEnvironment({}),
			/Provide BITBUCKET_TOKEN or BITBUCKET_USERNAME and BITBUCKET_PASSWORD/,
		);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewerConfig } from "../config/types.ts";
import { BitbucketTransport } from "./transport.ts";

const baseConfig: ReviewerConfig["bitbucket"] = {
	baseUrl: "https://bitbucket.example.com",
	projectKey: "PROJ",
	repoSlug: "repo",
	prId: 123,
	auth: {
		type: "bearer",
		token: "secret-token",
	},
	tls: {
		insecureSkipVerify: false,
	},
};

describe("BitbucketTransport", () => {
	it("includes trusted TLS guidance for certificate errors", async () => {
		const transport = new BitbucketTransport(baseConfig, {
			sendRequest: async () => {
				const error = new Error(
					"self-signed certificate in certificate chain",
				) as Error & {
					code?: string;
				};
				error.code = "SELF_SIGNED_CERT_IN_CHAIN";
				throw error;
			},
		});

		await assert.rejects(
			() => transport.request("/rest/api/latest/test"),
			(error: unknown) => {
				assert.match(
					String(error),
					/Set BITBUCKET_CA_CERT_PATH to your corporate CA PEM file, or run Node with NODE_USE_SYSTEM_CA=1 so it trusts your system CA store\./,
				);
				assert.doesNotMatch(String(error), /BITBUCKET_INSECURE_TLS/);
				return true;
			},
		);
	});

	it("merges caller headers into authenticated requests", async () => {
		let recordedHeaders: Record<string, string> | undefined;
		const transport = new BitbucketTransport(baseConfig, {
			sendRequest: async (_url, _method, headers) => {
				recordedHeaders = headers;
				return { statusCode: 200, statusMessage: "OK", body: "{}" };
			},
		});

		await transport.request("/rest/api/latest/test", {
			headers: {
				"X-Trace-Id": "trace-123",
				Accept: "application/json",
			},
		});

		assert.equal(recordedHeaders?.authorization, "Bearer secret-token");
		assert.equal(recordedHeaders?.accept, "application/json");
		assert.equal(recordedHeaders?.["x-trace-id"], "trace-123");
	});

	it("stringifies non-string request bodies before sending", async () => {
		let recordedBody: string | undefined;
		const transport = new BitbucketTransport(baseConfig, {
			sendRequest: async (_url, _method, _headers, body) => {
				recordedBody = body;
				return { statusCode: 200, statusMessage: "OK", body: "{}" };
			},
		});

		await transport.request("/rest/api/latest/test", {
			method: "POST",
			body: { toString: () => '{"text":"hello"}' } as BodyInit,
		});

		assert.equal(recordedBody, '{"text":"hello"}');
	});
});

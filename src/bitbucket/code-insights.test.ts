import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Logger } from "../shared/logger.ts";
import { CodeInsightsApi } from "./code-insights.ts";
import { type BitbucketRepoScope, createBitbucketRepoScope } from "./scope.ts";
import { BitbucketApiError } from "./transport.ts";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

function createApi(
	transport: BitbucketRepoScope["transport"],
): CodeInsightsApi {
	return new CodeInsightsApi(
		createBitbucketRepoScope(
			{ projectKey: "PROJ", repoSlug: "repo", prId: 123 },
			transport,
			logger,
		),
	);
}

describe("CodeInsightsApi", () => {
	it("returns undefined when a report does not exist", async () => {
		const api = createApi({
			request: async () => "",
			requestJson: async () => {
				throw new BitbucketApiError(
					404,
					"Not Found",
					"GET",
					"https://example.test",
					"missing",
				);
			},
		});

		assert.equal(await api.getReport("commit-1", "report-key"), undefined);
	});

	it("publishes by replacing the report with a single PUT", async () => {
		const calls: Array<{
			method: string | undefined;
			pathname: string;
			json: unknown;
		}> = [];
		const api = createApi({
			request: async (pathname, options) => {
				calls.push({ method: options?.method, pathname, json: options?.json });
				return "";
			},
			requestJson: async () => ({}) as never,
		});
		const report = {
			title: "Copilot PR Review",
			result: "FAIL" as const,
			reporter: "Copilot",
		};

		await api.putReport("commit-1", "report-key", report);

		assert.deepEqual(calls, [
			{
				method: "PUT",
				pathname:
					"/rest/insights/latest/projects/PROJ/repos/repo/commits/commit-1/reports/report-key",
				json: report,
			},
		]);
	});

	it("rejects report payloads with more than six data fields before sending", async () => {
		let requestCount = 0;
		const api = createApi({
			request: async () => {
				requestCount += 1;
				return "";
			},
			requestJson: async () => ({}) as never,
		});

		await assert.rejects(
			() =>
				api.putReport("commit-1", "report-key", {
					title: "Copilot PR Review",
					result: "FAIL",
					reporter: "Copilot",
					data: Array.from({ length: 7 }, (_, index) => ({
						title: `Field ${index + 1}`,
						type: "TEXT" as const,
						value: `value-${index + 1}`,
					})),
				}),
			/at most 6 report data fields/,
		);
		assert.equal(requestCount, 0);
	});
});

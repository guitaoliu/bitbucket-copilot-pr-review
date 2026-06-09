import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Logger } from "../shared/logger.ts";
import { CodeInsightsApi } from "./code-insights.ts";
import { BitbucketApiError } from "./transport.ts";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

describe("CodeInsightsApi", () => {
	it("returns undefined when a report does not exist", async () => {
		const api = new CodeInsightsApi(
			"PROJ",
			"repo",
			logger,
			async () => "",
			async () => {
				throw new BitbucketApiError(
					404,
					"Not Found",
					"GET",
					"https://example.test",
					"missing",
				);
			},
		);

		const result = await api.getCodeInsightsReport("commit-1", "report-key");

		assert.equal(result, undefined);
	});

	it("publishes by deleting and recreating the report only", async () => {
		const calls: string[] = [];
		const api = new CodeInsightsApi(
			"PROJ",
			"repo",
			logger,
			async (pathname, init) => {
				calls.push(`${init?.method ?? "GET"} ${pathname}`);
				return "";
			},
			async () => ({}) as never,
		);

		await api.publishCodeInsights("commit-1", "report-key", {
			title: "Copilot PR Review",
			result: "FAIL",
			reporter: "Copilot",
		});

		assert.deepEqual(calls, [
			"DELETE /rest/insights/latest/projects/PROJ/repos/repo/commits/commit-1/reports/report-key",
			"PUT /rest/insights/latest/projects/PROJ/repos/repo/commits/commit-1/reports/report-key",
		]);
	});

	it("rejects report payloads with more than six data fields before sending", async () => {
		const calls: string[] = [];
		const api = new CodeInsightsApi(
			"PROJ",
			"repo",
			logger,
			async (pathname, init) => {
				calls.push(`${init?.method ?? "GET"} ${pathname}`);
				return "";
			},
			async () => ({}) as never,
		);

		await assert.rejects(
			() =>
				api.createReport("commit-1", "report-key", {
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

		assert.deepEqual(calls, []);
	});
});

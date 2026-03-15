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

	it("publishes by deleting, recreating, and annotating in order", async () => {
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

		await api.publishCodeInsights(
			"commit-1",
			"report-key",
			{ title: "Copilot PR Review", result: "FAIL", reporter: "Copilot" },
			[{ externalId: "finding-1", message: "broken", severity: "HIGH" }],
		);

		assert.deepEqual(calls, [
			"DELETE /rest/insights/latest/projects/PROJ/repos/repo/commits/commit-1/reports/report-key",
			"PUT /rest/insights/latest/projects/PROJ/repos/repo/commits/commit-1/reports/report-key",
			"POST /rest/insights/latest/projects/PROJ/repos/repo/commits/commit-1/reports/report-key/annotations",
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

	it("lists annotations across paged results", async () => {
		const requestedPaths: string[] = [];
		const api = new CodeInsightsApi(
			"PROJ",
			"repo",
			logger,
			async () => "",
			async (pathname) => {
				requestedPaths.push(pathname);

				if (pathname.includes("start=0")) {
					return {
						annotations: [
							{
								externalId: "finding-1",
								message: "broken",
								severity: "HIGH",
							},
							{
								externalId: "finding-2",
								message: "also broken",
								severity: "MEDIUM",
							},
						],
						isLastPage: false,
						nextPageStart: 2,
					} as never;
				}

				return {
					annotations: [
						{
							externalId: "finding-3",
							message: "third issue",
							severity: "LOW",
						},
					],
					isLastPage: true,
				} as never;
			},
		);

		const result = await api.listCodeInsightsAnnotations(
			"commit-1",
			"report-key",
		);

		assert.equal(result.length, 3);
		assert.deepEqual(
			result.map((annotation) => annotation.externalId),
			["finding-1", "finding-2", "finding-3"],
		);
		assert.deepEqual(requestedPaths, [
			"/rest/insights/latest/projects/PROJ/repos/repo/commits/commit-1/reports/report-key/annotations?limit=1000&start=0",
			"/rest/insights/latest/projects/PROJ/repos/repo/commits/commit-1/reports/report-key/annotations?limit=1000&start=2",
		]);
	});

	it("counts raw annotations across paged results", async () => {
		const requestedPaths: string[] = [];
		const api = new CodeInsightsApi(
			"PROJ",
			"repo",
			logger,
			async () => "",
			async (pathname) => {
				requestedPaths.push(pathname);

				if (pathname.includes("start=0")) {
					return {
						annotations: [{ id: 1 }, { id: 2 }],
						isLastPage: false,
						nextPageStart: 2,
					} as never;
				}

				return {
					annotations: [{ id: 3 }],
					isLastPage: true,
				} as never;
			},
		);

		const result = await api.getCodeInsightsAnnotationCount(
			"commit-1",
			"report-key",
		);

		assert.equal(result, 3);
		assert.deepEqual(requestedPaths, [
			"/rest/insights/latest/projects/PROJ/repos/repo/commits/commit-1/reports/report-key/annotations?limit=1000&start=0",
			"/rest/insights/latest/projects/PROJ/repos/repo/commits/commit-1/reports/report-key/annotations?limit=1000&start=2",
		]);
	});

	it("uses totalCount when Bitbucket omits annotation bodies", async () => {
		const api = new CodeInsightsApi(
			"PROJ",
			"repo",
			logger,
			async () => "",
			async () =>
				({
					totalCount: 1,
					annotations: [],
				}) as never,
		);

		const result = await api.getCodeInsightsAnnotationCount(
			"commit-1",
			"report-key",
		);

		assert.equal(result, 1);
	});

	it("accepts legacy values arrays when listing annotations", async () => {
		const api = new CodeInsightsApi(
			"PROJ",
			"repo",
			logger,
			async () => "",
			async () =>
				({
					values: [
						{
							externalId: "finding-1",
							message: "broken",
							severity: "HIGH",
						},
					],
					isLastPage: true,
				}) as never,
		);

		const result = await api.listCodeInsightsAnnotations(
			"commit-1",
			"report-key",
		);

		assert.equal(result.length, 1);
		assert.equal(result[0]?.externalId, "finding-1");
	});
});

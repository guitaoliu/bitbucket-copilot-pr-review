import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Logger } from "../shared/logger.ts";
import { BITBUCKET_PR_COMMENT_MAX_CHARS } from "../shared/text.ts";
import { PullRequestCommentsApi } from "./comments.ts";
import { BitbucketApiError } from "./transport.ts";

type JsonResponder = <T>(pathname: string) => Promise<T>;
type RequestResponder = (
	pathname: string,
	init?: RequestInit,
) => Promise<string>;

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

const SUPERSEDED_PULL_REQUEST_COMMENT_TEXT =
	"_Superseded by a newer automated PR review summary. This thread is preserved because it has replies._";

describe("PullRequestCommentsApi.listPullRequestComments", () => {
	it("follows pagination and keeps the newest comment version", async () => {
		const requestedPaths: string[] = [];

		const requestJson: JsonResponder = async (pathname) => {
			requestedPaths.push(pathname);
			if (pathname.includes("start=0")) {
				return {
					values: [
						{
							action: "COMMENTED",
							comment: { id: 100, text: "old text", version: 1 },
						},
					],
					isLastPage: false,
					nextPageStart: 25,
				} as never;
			}

			return {
				values: [
					{
						action: "COMMENTED",
						comment: { id: 100, text: "new text", version: 2 },
					},
					{
						action: "COMMENTED",
						comment: { id: 200, text: "marker", version: 1 },
					},
				],
				isLastPage: true,
			} as never;
		};
		const request: RequestResponder = async () => "";
		const commentsApi = new PullRequestCommentsApi(
			"PROJ",
			"repo",
			123,
			logger,
			request,
			requestJson,
		);

		const comments = await commentsApi.listPullRequestComments();

		assert.deepEqual(requestedPaths, [
			"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/activities?limit=1000&start=0",
			"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/activities?limit=1000&start=25",
		]);
		assert.deepEqual(comments, [
			{ id: 100, text: "new text", version: 2 },
			{ id: 200, text: "marker", version: 1 },
		]);
	});

	it("prefers the newest tagged comment by timestamp across comments", async () => {
		const commentsApi = new PullRequestCommentsApi(
			"PROJ",
			"repo",
			123,
			logger,
			async () => "",
			async () =>
				({
					values: [
						{
							action: "COMMENTED",
							createdDate: 100,
							comment: {
								id: 10,
								text: "<!-- copilot-pr-review -->\nold",
								version: 9,
								createdDate: 100,
								updatedDate: 100,
							},
						},
						{
							action: "COMMENTED",
							createdDate: 200,
							comment: {
								id: 11,
								text: "<!-- copilot-pr-review -->\nnew",
								version: 1,
								createdDate: 200,
								updatedDate: 200,
							},
						},
					],
					isLastPage: true,
				}) as never,
		);

		const comment =
			await commentsApi.findPullRequestCommentByTag("copilot-pr-review");

		assert.deepEqual(comment, {
			id: 11,
			text: "<!-- copilot-pr-review -->\nnew",
			version: 1,
			createdDate: 200,
			updatedDate: 200,
		});
	});
});

describe("PullRequestCommentsApi.upsertPullRequestComment", () => {
	it("rejects oversized comments before sending the request", async () => {
		let requestCount = 0;
		const commentsApi = new PullRequestCommentsApi(
			"PROJ",
			"repo",
			123,
			logger,
			async () => {
				requestCount += 1;
				return "";
			},
			async () => ({ values: [], isLastPage: true }) as never,
		);

		await assert.rejects(
			commentsApi.upsertPullRequestComment(
				"copilot-pr-review",
				"x".repeat(BITBUCKET_PR_COMMENT_MAX_CHARS + 1),
			),
			/exceeds the local Bitbucket safety limit/,
		);
		assert.equal(requestCount, 0);
	});

	it("rejects empty comments before sending the request", async () => {
		let requestCount = 0;
		const commentsApi = new PullRequestCommentsApi(
			"PROJ",
			"repo",
			123,
			logger,
			async () => {
				requestCount += 1;
				return "";
			},
			async () => ({ values: [], isLastPage: true }) as never,
		);

		await assert.rejects(
			commentsApi.upsertPullRequestComment("copilot-pr-review", "   \n\t "),
			/must not be empty/,
		);
		assert.equal(requestCount, 0);
	});

	it("recreates the tagged comment and deletes older tagged comments", async () => {
		const requestCalls: Array<{
			pathname: string;
			method: string | undefined;
			body: string | undefined;
		}> = [];
		const commentsApi = new PullRequestCommentsApi(
			"PROJ",
			"repo",
			123,
			logger,
			async (pathname, init) => {
				requestCalls.push({
					pathname,
					method: init?.method,
					body: typeof init?.body === "string" ? init.body : undefined,
				});
				return "";
			},
			async () =>
				({
					values: [
						{
							action: "COMMENTED",
							createdDate: 100,
							comment: {
								id: 10,
								text: "<!-- copilot-pr-review -->\noldest",
								version: 2,
								createdDate: 100,
								updatedDate: 100,
							},
						},
						{
							action: "COMMENTED",
							createdDate: 200,
							comment: {
								id: 11,
								text: "<!-- copilot-pr-review -->\nold",
								version: 3,
								createdDate: 200,
								updatedDate: 200,
							},
						},
					],
					isLastPage: true,
				}) as never,
		);

		await commentsApi.upsertPullRequestComment(
			"copilot-pr-review",
			"<!-- copilot-pr-review -->\nreplacement",
			{ strategy: "recreate" },
		);

		assert.deepEqual(requestCalls, [
			{
				pathname:
					"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/comments",
				method: "POST",
				body: JSON.stringify({
					text: "<!-- copilot-pr-review -->\nreplacement",
				}),
			},
			{
				pathname:
					"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/comments/11?version=3",
				method: "DELETE",
				body: undefined,
			},
			{
				pathname:
					"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/comments/10?version=2",
				method: "DELETE",
				body: undefined,
			},
		]);
	});

	it("warns and continues when deleting a superseded comment fails", async () => {
		const warnMessages: string[] = [];
		const commentsApi = new PullRequestCommentsApi(
			"PROJ",
			"repo",
			123,
			{
				...logger,
				warn(message) {
					warnMessages.push(message);
				},
			},
			async (pathname, init) => {
				if (
					init?.method === "DELETE" &&
					pathname.endsWith("/comments/10?version=2")
				) {
					throw new Error("delete failed");
				}
				return "";
			},
			async () =>
				({
					values: [
						{
							action: "COMMENTED",
							createdDate: 100,
							comment: {
								id: 10,
								text: "<!-- copilot-pr-review -->\nold",
								version: 2,
								createdDate: 100,
								updatedDate: 100,
							},
						},
					],
					isLastPage: true,
				}) as never,
		);

		await commentsApi.upsertPullRequestComment(
			"copilot-pr-review",
			"<!-- copilot-pr-review -->\nreplacement",
			{ strategy: "recreate" },
		);

		assert.deepEqual(warnMessages, [
			"Failed to delete superseded pull request summary comment 10 tagged copilot-pr-review: delete failed",
		]);
	});

	it("archives a superseded comment when delete is blocked by replies", async () => {
		const requestCalls: Array<{
			pathname: string;
			method: string | undefined;
			body: string | undefined;
		}> = [];
		const warnMessages: string[] = [];
		const commentsApi = new PullRequestCommentsApi(
			"PROJ",
			"repo",
			123,
			{
				...logger,
				warn(message) {
					warnMessages.push(message);
				},
			},
			async (pathname, init) => {
				requestCalls.push({
					pathname,
					method: init?.method,
					body: typeof init?.body === "string" ? init.body : undefined,
				});

				if (
					init?.method === "DELETE" &&
					pathname.endsWith("/comments/10?version=2")
				) {
					throw new BitbucketApiError(
						409,
						"Conflict",
						"DELETE",
						"https://bitbucket.example.com/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/comments/10?version=2",
						JSON.stringify({
							errors: [
								{
									message:
										"This comment has replies which must be deleted first.",
									exceptionName:
										"com.atlassian.bitbucket.comment.CommentDeletionException",
								},
							],
						}),
					);
				}

				return "";
			},
			async () =>
				({
					values: [
						{
							action: "COMMENTED",
							createdDate: 100,
							comment: {
								id: 10,
								text: "<!-- copilot-pr-review -->\nold",
								version: 2,
								createdDate: 100,
								updatedDate: 100,
							},
						},
					],
					isLastPage: true,
				}) as never,
		);

		await commentsApi.upsertPullRequestComment(
			"copilot-pr-review",
			"<!-- copilot-pr-review -->\nreplacement",
			{ strategy: "recreate" },
		);

		assert.deepEqual(requestCalls, [
			{
				pathname:
					"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/comments",
				method: "POST",
				body: JSON.stringify({
					text: "<!-- copilot-pr-review -->\nreplacement",
				}),
			},
			{
				pathname:
					"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/comments/10?version=2",
				method: "DELETE",
				body: undefined,
			},
			{
				pathname:
					"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/comments/10",
				method: "PUT",
				body: JSON.stringify({
					version: 2,
					text: SUPERSEDED_PULL_REQUEST_COMMENT_TEXT,
				}),
			},
		]);
		assert.deepEqual(warnMessages, []);
	});
});

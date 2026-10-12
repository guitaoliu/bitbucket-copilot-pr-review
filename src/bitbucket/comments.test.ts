import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Logger } from "../shared/logger.ts";
import { BITBUCKET_PR_COMMENT_MAX_CHARS } from "../shared/text.ts";
import { PullRequestCommentsApi } from "./comments.ts";
import { createBitbucketRepoScope } from "./scope.ts";
import type { BitbucketRequest } from "./transport.ts";
import type { RawBitbucketCommentActivity } from "./types.ts";

const COMMENTS_PATH =
	"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/comments";

interface RecordedRequest {
	method: string;
	pathname: string;
	json?: unknown;
}

function createApi(pages: RawBitbucketCommentActivity[][] = [[]]): {
	api: PullRequestCommentsApi;
	requests: RecordedRequest[];
	listed: string[];
} {
	const requests: RecordedRequest[] = [];
	const listed: string[] = [];
	const logger: Logger = {
		debug() {},
		info() {},
		warn() {},
		error() {},
		trace() {},
		json() {},
	};
	const api = new PullRequestCommentsApi(
		createBitbucketRepoScope(
			{ projectKey: "PROJ", repoSlug: "repo", prId: 123 },
			{
				request: async (pathname: string, request?: BitbucketRequest) => {
					requests.push({
						method: request?.method ?? "GET",
						pathname: pathname.replace(COMMENTS_PATH, ""),
						...(request?.json === undefined ? {} : { json: request.json }),
					});
					return "";
				},
				requestJson: async <T>(pathname: string) => {
					if (pathname.startsWith(`${COMMENTS_PATH}/`)) {
						requests.push({
							method: "GET",
							pathname: pathname.replace(COMMENTS_PATH, ""),
						});
						return { version: 4 } as T;
					}
					listed.push(pathname);
					const index = listed.length - 1;
					return {
						values: pages[index] ?? [],
						isLastPage: index >= pages.length - 1,
						...(index < pages.length - 1
							? { nextPageStart: (index + 1) * 25 }
							: {}),
					} as T;
				},
			},
			logger,
		),
	);
	return { api, requests, listed };
}

const comment = { id: 11, version: 3 };

describe("PullRequestCommentsApi.listComments", () => {
	it("follows pagination and keeps the newest version of each comment", async () => {
		const { api, listed, requests } = createApi([
			[
				{
					action: "COMMENTED",
					comment: { id: 100, version: 1, text: "old text", createdDate: 100 },
				},
			],
			[
				{
					action: "COMMENTED",
					createdDate: 150,
					comment: { id: 100, version: 2, text: "new text" },
				},
				{
					action: "COMMENTED",
					comment: { id: 200, version: 0, text: null, createdDate: 300 },
				},
				{ action: "APPROVED" },
			],
		]);

		const comments = await api.listComments();

		assert.deepEqual(listed, [
			"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/activities?limit=1000&start=0",
			"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/activities?limit=1000&start=25",
		]);
		assert.deepEqual(
			comments.map(({ id, version, text, createdDate }) => [
				id,
				version,
				text,
				createdDate,
			]),
			[
				[100, 2, "new text", 150],
				[200, 0, "", 300],
			],
		);
		assert.deepEqual(requests, []);
	});

	it("reports the author, thread state, and replies of each comment", async () => {
		const { api } = createApi([
			[
				{
					action: "COMMENTED",
					comment: {
						id: 7,
						version: 4,
						text: "finding",
						author: { name: "review-bot" },
						threadResolved: true,
						comments: [
							{ text: "won't fix", author: { name: "dev" } },
							{ text: null },
						],
						createdDate: 10,
					},
				},
				{
					action: "COMMENTED",
					comment: { id: 5, version: 0, text: "general" },
				},
			],
		]);

		assert.deepEqual(await api.listComments(), [
			{
				id: 7,
				version: 4,
				text: "finding",
				authorName: "review-bot",
				threadResolved: true,
				replies: [{ authorName: "dev", text: "won't fix" }, { text: "" }],
				createdDate: 10,
			},
			{
				id: 5,
				version: 0,
				text: "general",
				threadResolved: false,
				replies: [],
			},
		]);
	});
});

describe("PullRequestCommentsApi writes", () => {
	it("creates anchored comments on the added side of the effective diff and top-level ones otherwise", async () => {
		const { api, requests } = createApi();

		await api.createComment("anchored", { path: "src/a.ts", line: 7 });
		await api.createComment("top-level");

		assert.deepEqual(requests, [
			{
				method: "POST",
				pathname: "",
				json: {
					text: "anchored",
					anchor: {
						diffType: "EFFECTIVE",
						path: "src/a.ts",
						line: 7,
						lineType: "ADDED",
						fileType: "TO",
					},
				},
			},
			{ method: "POST", pathname: "", json: { text: "top-level" } },
		]);
	});

	it("updates and deletes at the listed version, replies, and resolves at the current version", async () => {
		const { api, requests } = createApi();

		await api.updateComment(comment, "new text");
		await api.deleteComment(comment);
		await api.replyToComment(comment, "reply text");
		await api.resolveThread(comment);

		assert.deepEqual(requests, [
			{
				method: "PUT",
				pathname: "/11",
				json: { version: 3, text: "new text" },
			},
			{ method: "DELETE", pathname: "/11?version=3" },
			{
				method: "POST",
				pathname: "",
				json: { text: "reply text", parent: { id: 11 } },
			},
			{ method: "GET", pathname: "/11" },
			{
				method: "PUT",
				pathname: "/11",
				json: { version: 4, threadResolved: true },
			},
		]);
	});

	it("rejects oversized and empty text before sending the request", async () => {
		const { api, requests } = createApi();
		const oversized = "x".repeat(BITBUCKET_PR_COMMENT_MAX_CHARS + 1);

		await assert.rejects(api.createComment(oversized), /safety limit/);
		await assert.rejects(api.updateComment(comment, "   \n\t "), /empty/);
		await assert.rejects(api.replyToComment(comment, oversized), /limit/);
		assert.deepEqual(requests, []);
	});
});

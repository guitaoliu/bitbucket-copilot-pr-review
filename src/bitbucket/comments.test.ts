import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Logger } from "../shared/logger.ts";
import { BITBUCKET_PR_COMMENT_MAX_CHARS } from "../shared/text.ts";
import { PullRequestCommentsApi } from "./comments.ts";
import { createBitbucketRepoScope } from "./scope.ts";
import { BitbucketApiError, type BitbucketRequest } from "./transport.ts";
import type {
	PullRequestComment,
	RawBitbucketCommentActivity,
} from "./types.ts";

const COMMENTS_PATH =
	"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/comments";
const retirement = { label: "test comment", supersededText: "_Superseded._" };

interface RecordedRequest {
	method: string;
	pathname: string;
	json?: unknown;
}

function createApi(
	options: {
		pages?: RawBitbucketCommentActivity[][];
		respond?: (request: RecordedRequest) => void;
		logger?: Partial<Logger>;
	} = {},
): {
	api: PullRequestCommentsApi;
	requests: RecordedRequest[];
	listed: string[];
} {
	const requests: RecordedRequest[] = [];
	const listed: string[] = [];
	const pages = options.pages ?? [[]];
	const logger: Logger = {
		debug() {},
		info() {},
		warn() {},
		error() {},
		trace() {},
		json() {},
		...options.logger,
	};
	const api = new PullRequestCommentsApi(
		createBitbucketRepoScope(
			{ projectKey: "PROJ", repoSlug: "repo", prId: 123 },
			{
				request: async (pathname: string, request?: BitbucketRequest) => {
					const recorded = {
						method: request?.method ?? "GET",
						pathname: pathname.replace(COMMENTS_PATH, ""),
						...(request?.json === undefined ? {} : { json: request.json }),
					};
					requests.push(recorded);
					options.respond?.(recorded);
					return "";
				},
				requestJson: async <T>(pathname: string) => {
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

function activity(
	id: number,
	text: string,
	options: { version?: number; date?: number } = {},
): RawBitbucketCommentActivity {
	return {
		action: "COMMENTED",
		comment: {
			id,
			text,
			version: options.version ?? 0,
			...(options.date === undefined
				? {}
				: { createdDate: options.date, updatedDate: options.date }),
		},
	};
}

function comment(id: number, text: string, version = 0): PullRequestComment {
	return { id, text, version };
}

function bitbucketError(statusCode: number, body: string): BitbucketApiError {
	return new BitbucketApiError(
		statusCode,
		"Error",
		"DELETE",
		"https://example.test",
		body,
	);
}

const keyOf = (text: string) => /key:(\w+)/.exec(text)?.[1];

describe("PullRequestCommentsApi.listComments", () => {
	it("follows pagination, keeps the newest version, and sorts newest first", async () => {
		const { api, listed, requests } = createApi({
			pages: [
				[activity(100, "old text", { version: 1, date: 100 })],
				[
					activity(100, "new text", { version: 2, date: 100 }),
					activity(200, "newer comment", { version: 1, date: 300 }),
					{ action: "APPROVED" },
				],
			],
		});

		const comments = await api.listComments();

		assert.deepEqual(listed, [
			"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/activities?limit=1000&start=0",
			"/rest/api/latest/projects/PROJ/repos/repo/pull-requests/123/activities?limit=1000&start=25",
		]);
		assert.deepEqual(
			comments.map(({ id, text }) => [id, text]),
			[
				[200, "newer comment"],
				[100, "new text"],
			],
		);
		assert.deepEqual(requests, []);
	});

	it("does not delete duplicate tagged comments while listing", async () => {
		const { api, requests } = createApi({
			pages: [[activity(1, "key:a"), activity(2, "key:a")]],
		});

		await api.listComments();

		assert.deepEqual(requests, []);
	});
});

describe("PullRequestCommentsApi.upsertComment", () => {
	it("rejects oversized and empty comments before sending the request", async () => {
		const { api, requests } = createApi();

		await assert.rejects(
			api.upsertComment([], "x".repeat(BITBUCKET_PR_COMMENT_MAX_CHARS + 1), {
				strategy: "recreate",
				retirement,
			}),
			/exceeds the local Bitbucket safety limit/,
		);
		await assert.rejects(
			api.upsertComment([], "   \n\t ", { strategy: "recreate", retirement }),
			/must not be empty/,
		);
		assert.deepEqual(requests, []);
	});

	it("recreates the comment and deletes every superseded one", async () => {
		const { api, requests } = createApi();

		await api.upsertComment(
			[comment(11, "old", 3), comment(10, "oldest", 2)],
			"replacement",
			{ strategy: "recreate", retirement },
		);

		assert.deepEqual(requests, [
			{ method: "POST", pathname: "", json: { text: "replacement" } },
			{ method: "DELETE", pathname: "/11?version=3" },
			{ method: "DELETE", pathname: "/10?version=2" },
		]);
	});

	it("updates the newest comment in place with the update strategy", async () => {
		const { api, requests } = createApi();

		await api.upsertComment(
			[comment(11, "old", 3), comment(10, "oldest", 2)],
			"replacement",
			{ strategy: "update", retirement },
		);

		assert.deepEqual(requests, [
			{
				method: "PUT",
				pathname: "/11",
				json: { version: 3, text: "replacement" },
			},
		]);
	});

	it("archives a superseded comment when delete is blocked by replies", async () => {
		const { api, requests } = createApi({
			respond: (request) => {
				if (request.method === "DELETE") {
					throw bitbucketError(
						409,
						"com.atlassian.bitbucket.comment.CommentDeletionException: replies which must be deleted first",
					);
				}
			},
		});

		await api.upsertComment([comment(11, "old", 3)], "replacement", {
			strategy: "recreate",
			retirement,
		});

		assert.deepEqual(requests.at(-1), {
			method: "PUT",
			pathname: "/11",
			json: { version: 3, text: "_Superseded._" },
		});
	});

	it("leaves resolved-thread comments in place without warning", async () => {
		const warnings: string[] = [];
		const { api, requests } = createApi({
			logger: { warn: (message) => warnings.push(message) },
			respond: (request) => {
				if (request.method === "DELETE") {
					throw bitbucketError(
						400,
						"Comments cannot be deleted from resolved thread",
					);
				}
			},
		});

		await api.upsertComment([comment(11, "old", 3)], "replacement", {
			strategy: "recreate",
			retirement,
		});

		assert.deepEqual(
			requests.map(({ method }) => method),
			["POST", "DELETE"],
		);
		assert.deepEqual(warnings, []);
	});

	it("warns and continues when deleting a superseded comment fails", async () => {
		const warnings: string[] = [];
		const { api, requests } = createApi({
			logger: { warn: (message) => warnings.push(message) },
			respond: (request) => {
				if (request.method === "DELETE") {
					throw new Error("network down");
				}
			},
		});

		await api.upsertComment(
			[comment(11, "old", 3), comment(10, "oldest", 2)],
			"replacement",
			{ strategy: "recreate", retirement },
		);

		assert.equal(requests.length, 3);
		assert.match(
			warnings[0] ?? "",
			/Failed to delete test comment 11: network down/,
		);
	});
});

describe("PullRequestCommentsApi.reconcileKeyedComments", () => {
	it("creates anchored comments for drafts with a location and top-level ones otherwise", async () => {
		const { api, requests } = createApi();

		await api.reconcileKeyedComments(
			[],
			[
				{ keys: ["a"], text: "key:a", anchor: { path: "src/a.ts", line: 7 } },
				{ keys: ["b"], text: "key:b" },
			],
			{ keyOf, retirement },
		);

		assert.deepEqual(requests, [
			{
				method: "POST",
				pathname: "",
				json: {
					text: "key:a",
					anchor: {
						diffType: "EFFECTIVE",
						path: "src/a.ts",
						line: 7,
						lineType: "ADDED",
						fileType: "TO",
					},
				},
			},
			{ method: "POST", pathname: "", json: { text: "key:b" } },
		]);
	});

	it("updates matching comments, retires duplicates and unmatched ones, and ignores untagged comments", async () => {
		const { api, requests } = createApi();

		await api.reconcileKeyedComments(
			[
				comment(3, "key:a newest", 4),
				comment(2, "key:a duplicate", 1),
				comment(1, "key:stale", 2),
				comment(9, "human comment", 1),
			],
			[{ keys: ["a"], text: "key:a updated" }],
			{ keyOf, retirement },
		);

		assert.deepEqual(requests, [
			{
				method: "PUT",
				pathname: "/3",
				json: { version: 4, text: "key:a updated" },
			},
			{ method: "DELETE", pathname: "/2?version=1" },
			{ method: "DELETE", pathname: "/1?version=2" },
		]);
	});

	it("falls back to a later key such as a legacy identifier", async () => {
		const { api, requests } = createApi();

		await api.reconcileKeyedComments(
			[comment(5, "key:legacy", 1)],
			[{ keys: ["thread", "legacy"], text: "key:thread" }],
			{ keyOf, retirement },
		);

		assert.deepEqual(requests, [
			{
				method: "PUT",
				pathname: "/5",
				json: { version: 1, text: "key:thread" },
			},
		]);
	});

	it("creates a replacement when the matching comment is in a resolved thread", async () => {
		const { api, requests } = createApi({
			respond: (request) => {
				if (request.method === "PUT") {
					throw bitbucketError(
						400,
						"Changes cannot be made to resolved thread",
					);
				}
			},
		});

		await api.reconcileKeyedComments(
			[comment(3, "key:a", 4)],
			[
				{
					keys: ["a"],
					text: "key:a updated",
					anchor: { path: "src/a.ts", line: 1 },
				},
			],
			{ keyOf, retirement },
		);

		assert.deepEqual(
			requests.map(({ method, pathname }) => `${method} ${pathname}`),
			["PUT /3", "POST "],
		);
	});

	it("propagates update failures other than resolved threads", async () => {
		const { api } = createApi({
			respond: (request) => {
				if (request.method === "PUT") {
					throw bitbucketError(409, "stale version");
				}
			},
		});

		await assert.rejects(
			api.reconcileKeyedComments(
				[comment(3, "key:a", 4)],
				[{ keys: ["a"], text: "key:a updated" }],
				{ keyOf, retirement },
			),
			/stale version/,
		);
	});
});

import { createServer } from "node:http";

import { closeServer, listenOnLoopback, readRequestBody } from "./http.ts";

export const BOT_USER_NAME = "review-bot";

export interface FakePullRequest {
	projectKey: string;
	repoSlug: string;
	id: number;
	baseCommit: string;
	headCommit: string;
}

export interface FakeComment {
	id: number;
	version: number;
	text: string;
	author: { name: string; slug: string };
	threadResolved: boolean;
	createdDate: number;
	comments: FakeComment[];
	anchor?: { path: string; line: number };
}

export interface FakeBitbucket {
	url: string;
	pullRequestUrl: string;
	pullRequest: FakePullRequest;
	requests: string[];
	/** Top-level comments by id; replies live in their parent's `comments`. */
	comments: Map<number, FakeComment>;
	reports: Map<string, Record<string, unknown>>;
	addComment(
		text: string,
		options?: { anchor?: FakeComment["anchor"]; author?: string },
	): FakeComment;
	close(): Promise<void>;
}

/**
 * In-memory Bitbucket Data Center covering the pull request, activity,
 * comment, and Code Insights endpoints the reviewer calls. Like the real
 * server it names the authenticated user in `X-AUSERNAME`, records comment
 * authors, nests replies, and enforces comment versions, authorship, and
 * resolved-thread rules. Activities are listed newest first and paged by at
 * most `activityPageSize` entries.
 */
export async function startFakeBitbucket(
	pullRequest: FakePullRequest,
	options: { activityPageSize?: number; botUserName?: string } = {},
): Promise<FakeBitbucket> {
	const requests: string[] = [];
	const comments = new Map<number, FakeComment>();
	const threadRoots = new Map<number, FakeComment>();
	const replies = new Map<number, FakeComment>();
	const reports = new Map<string, Record<string, unknown>>();
	const activityPageSize = options.activityPageSize ?? 1000;
	const botUserName = options.botUserName ?? BOT_USER_NAME;
	let nextCommentId = 1;
	let clock = Date.now();
	const createComment = (
		text: string,
		author: string,
		anchor?: FakeComment["anchor"],
	): FakeComment => ({
		id: nextCommentId++,
		version: 0,
		text,
		author: { name: author, slug: author },
		threadResolved: false,
		createdDate: clock++,
		comments: [],
		...(anchor ? { anchor: { path: anchor.path, line: anchor.line } } : {}),
	});
	const addComment: FakeBitbucket["addComment"] = (text, commentOptions) => {
		const comment = createComment(
			text,
			commentOptions?.author ?? botUserName,
			commentOptions?.anchor,
		);
		comments.set(comment.id, comment);
		return comment;
	};
	const pullRequestPath = `/rest/api/latest/projects/${pullRequest.projectKey}/repos/${pullRequest.repoSlug}/pull-requests/${pullRequest.id}`;
	const reportPattern =
		/^\/rest\/insights\/latest\/projects\/[^/]+\/repos\/[^/]+\/commits\/([^/]+)\/reports\/([^/]+)$/;
	const commentPattern = new RegExp(`^${pullRequestPath}/comments/(\\d+)$`);
	const repository = {
		id: 1,
		slug: pullRequest.repoSlug,
		project: { key: pullRequest.projectKey },
	};
	const findComment = (id: number) => comments.get(id) ?? replies.get(id);
	const rootOf = (comment: FakeComment) =>
		threadRoots.get(comment.id) ?? comment;

	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://bitbucket.invalid");
		const method = request.method ?? "GET";
		const rawBody = await readRequestBody(request);
		const body = rawBody ? JSON.parse(rawBody) : undefined;
		const reply = (status: number, payload?: unknown) => {
			response.writeHead(status, {
				"content-type": "application/json",
				"x-ausername": botUserName,
			});
			response.end(payload === undefined ? "" : JSON.stringify(payload));
		};
		const fail = (status: number, exceptionName: string, message: string) =>
			reply(status, { errors: [{ exceptionName, message }] });
		requests.push(`${method} ${url.pathname}${url.search}`);

		if (
			method === "GET" &&
			url.pathname === "/rest/api/latest/application-properties"
		) {
			reply(200, { version: "9.4.26", displayName: "Bitbucket" });
			return;
		}

		if (method === "GET" && url.pathname === pullRequestPath) {
			reply(200, {
				id: pullRequest.id,
				version: 1,
				state: "OPEN",
				draft: false,
				title: "Simplify equality check",
				description: "Uses a shorter comparison.",
				fromRef: {
					id: "refs/heads/feature",
					displayId: "feature",
					latestCommit: pullRequest.headCommit,
					repository,
				},
				toRef: {
					id: "refs/heads/master",
					displayId: "master",
					latestCommit: pullRequest.baseCommit,
					repository,
				},
			});
			return;
		}

		if (method === "GET" && url.pathname === `${pullRequestPath}/activities`) {
			const start = Number(url.searchParams.get("start") ?? 0);
			const limit = Math.min(
				Number(url.searchParams.get("limit") ?? 25),
				activityPageSize,
			);
			const activities = [...comments.values()].reverse();
			const values = activities.slice(start, start + limit);
			const isLastPage = start + values.length >= activities.length;
			reply(200, {
				start,
				limit,
				size: values.length,
				values: values.map((comment) => ({
					id: comment.id,
					action: "COMMENTED",
					comment,
				})),
				isLastPage,
				...(isLastPage ? {} : { nextPageStart: start + values.length }),
			});
			return;
		}

		if (method === "POST" && url.pathname === `${pullRequestPath}/comments`) {
			if (body.parent === undefined) {
				reply(201, addComment(body.text, { anchor: body.anchor }));
				return;
			}

			const parent = findComment(Number(body.parent.id));
			if (!parent) {
				fail(404, "NoSuchCommentException", "Parent comment not found.");
				return;
			}
			const root = rootOf(parent);
			if (root.threadResolved) {
				fail(
					400,
					"IllegalCommentStateException",
					"Changes cannot be made to resolved thread.",
				);
				return;
			}
			const created = createComment(body.text, botUserName);
			parent.comments.push(created);
			replies.set(created.id, created);
			threadRoots.set(created.id, root);
			reply(201, created);
			return;
		}

		const commentId = url.pathname.match(commentPattern)?.[1];
		const comment =
			commentId === undefined ? undefined : findComment(Number(commentId));
		if (comment && method === "GET") {
			reply(200, comment);
			return;
		}
		if (comment && (method === "PUT" || method === "DELETE")) {
			const version = Number(
				method === "PUT" ? body.version : url.searchParams.get("version"),
			);
			const ownsComment = comment.author.name === botUserName;
			const root = rootOf(comment);
			if (version !== comment.version) {
				fail(
					409,
					"CommentOutOfDateException",
					`You are attempting to modify a comment based on out-of-date information (version ${version}, current ${comment.version}).`,
				);
				return;
			}

			if (method === "PUT") {
				if (body.text !== undefined && !ownsComment) {
					fail(
						403,
						"AuthorisationException",
						"Only the author can edit a comment.",
					);
					return;
				}
				if (body.text !== undefined && root.threadResolved) {
					fail(
						400,
						"IllegalCommentStateException",
						"Changes cannot be made to resolved thread.",
					);
					return;
				}
				if (body.text !== undefined) {
					comment.text = body.text;
				}
				if (body.threadResolved !== undefined) {
					comment.threadResolved = body.threadResolved === true;
				}
				comment.version += 1;
				reply(200, comment);
				return;
			}

			if (!ownsComment) {
				fail(
					403,
					"AuthorisationException",
					"Only the author can delete a comment.",
				);
				return;
			}
			if (comment.comments.length > 0) {
				fail(
					409,
					"CommentDeletionException",
					"This comment has replies which must be deleted first.",
				);
				return;
			}
			if (root.threadResolved) {
				fail(
					400,
					"IllegalCommentStateException",
					"Comments cannot be deleted from resolved thread.",
				);
				return;
			}
			comments.delete(comment.id);
			replies.delete(comment.id);
			reply(204);
			return;
		}

		const reportMatch = url.pathname.match(reportPattern);
		if (reportMatch) {
			const key = `${reportMatch[1]}/${reportMatch[2]}`;
			const report = reports.get(key);
			if (method === "GET") {
				reply(report ? 200 : 404, report);
				return;
			}
			if (method === "PUT") {
				reports.set(key, body);
				reply(200, body);
				return;
			}
			if (method === "DELETE") {
				reports.delete(key);
				reply(204);
				return;
			}
		}

		fail(404, "NotFoundException", `Unhandled ${method} ${url.pathname}`);
	});

	const url = await listenOnLoopback(server);
	return {
		url,
		pullRequestUrl: `${url}/projects/${pullRequest.projectKey}/repos/${pullRequest.repoSlug}/pull-requests/${pullRequest.id}`,
		pullRequest,
		requests,
		comments,
		reports,
		addComment,
		close: () => closeServer(server),
	};
}

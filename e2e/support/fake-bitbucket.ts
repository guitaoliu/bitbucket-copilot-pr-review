import { createServer, type ServerResponse } from "node:http";

import { closeServer, listenOnLoopback, readRequestBody } from "./http.ts";

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
	anchor?: { path: string; line: number };
}

export interface FakeBitbucket {
	url: string;
	pullRequestUrl: string;
	pullRequest: FakePullRequest;
	requests: string[];
	comments: Map<number, FakeComment>;
	reports: Map<string, Record<string, unknown>>;
	addComment(text: string, anchor?: FakeComment["anchor"]): FakeComment;
	close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body?: unknown) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(body === undefined ? "" : JSON.stringify(body));
}

/**
 * In-memory Bitbucket Data Center covering the pull request, activity,
 * comment, and Code Insights endpoints the reviewer calls. Activities are
 * listed newest first and paged by at most `activityPageSize` entries.
 */
export async function startFakeBitbucket(
	pullRequest: FakePullRequest,
	options: { activityPageSize?: number } = {},
): Promise<FakeBitbucket> {
	const requests: string[] = [];
	const comments = new Map<number, FakeComment>();
	const reports = new Map<string, Record<string, unknown>>();
	const activityPageSize = options.activityPageSize ?? 1000;
	let nextCommentId = 1;
	const addComment = (
		text: string,
		anchor?: FakeComment["anchor"],
	): FakeComment => {
		const comment: FakeComment = {
			id: nextCommentId++,
			version: 0,
			text,
			...(anchor ? { anchor: { path: anchor.path, line: anchor.line } } : {}),
		};
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

	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://bitbucket.invalid");
		const method = request.method ?? "GET";
		const rawBody = await readRequestBody(request);
		const body = rawBody ? JSON.parse(rawBody) : undefined;
		requests.push(`${method} ${url.pathname}${url.search}`);

		if (method === "GET" && url.pathname === pullRequestPath) {
			sendJson(response, 200, {
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
			sendJson(response, 200, {
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
			sendJson(response, 201, addComment(body.text, body.anchor));
			return;
		}

		const commentId = url.pathname.match(commentPattern)?.[1];
		const comment =
			commentId === undefined ? undefined : comments.get(Number(commentId));
		if (comment && method === "PUT") {
			comment.text = body.text;
			comment.version += 1;
			sendJson(response, 200, comment);
			return;
		}
		if (comment && method === "DELETE") {
			comments.delete(comment.id);
			sendJson(response, 204);
			return;
		}

		const reportMatch = url.pathname.match(reportPattern);
		if (reportMatch) {
			const key = `${reportMatch[1]}/${reportMatch[2]}`;
			const report = reports.get(key);
			if (method === "GET") {
				sendJson(response, report ? 200 : 404, report);
				return;
			}
			if (method === "PUT") {
				reports.set(key, body);
				sendJson(response, 200, body);
				return;
			}
			if (method === "DELETE") {
				reports.delete(key);
				sendJson(response, 204);
				return;
			}
		}

		sendJson(response, 404, {
			errors: [{ message: `Unhandled ${method} ${url.pathname}` }],
		});
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

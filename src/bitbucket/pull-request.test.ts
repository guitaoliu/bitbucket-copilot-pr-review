import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PullRequestApi, RepositoryPullRequestApi } from "./pull-request.ts";

describe("PullRequestApi", () => {
	it("normalizes pull request payloads and prefers HTTP clone URLs", async () => {
		const api = new PullRequestApi(
			"PROJ",
			"repo",
			123,
			async () =>
				({
					id: 123,
					version: 7,
					state: "OPEN",
					draft: true,
					title: "Test PR",
					description: "  Description here  ",
					links: {
						self: [
							{
								href: "https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123",
							},
						],
					},
					fromRef: {
						id: "refs/heads/feature",
						displayId: "feature",
						latestCommit: "head-123",
						repository: {
							id: 1,
							slug: "repo",
							project: { key: "PROJ" },
							links: {
								clone: [
									{ name: "ssh", href: "ssh://git@example.com/repo.git" },
									{
										name: "http",
										href: "https://bitbucket.example.com/scm/proj/repo.git",
									},
								],
							},
						},
					},
					toRef: {
						id: "refs/heads/main",
						displayId: "main",
						latestCommit: "base-123",
						repository: {
							id: 1,
							slug: "repo",
							project: { key: "PROJ" },
							links: {
								clone: [
									{ name: "ssh", href: "ssh://git@example.com/repo.git" },
								],
							},
						},
					},
				}) as never,
		);

		const result = await api.getPullRequest();

		assert.deepEqual(result, {
			id: 123,
			version: 7,
			state: "OPEN",
			draft: true,
			title: "Test PR",
			description: "Description here",
			link: "https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123",
			source: {
				repositoryId: 1,
				projectKey: "PROJ",
				repoSlug: "repo",
				cloneUrl: "https://bitbucket.example.com/scm/proj/repo.git",
				refId: "refs/heads/feature",
				displayId: "feature",
				latestCommit: "head-123",
			},
			target: {
				repositoryId: 1,
				projectKey: "PROJ",
				repoSlug: "repo",
				cloneUrl: "ssh://git@example.com/repo.git",
				refId: "refs/heads/main",
				displayId: "main",
				latestCommit: "base-123",
			},
		});
	});

	it("preserves the pull request state for downstream review guards", async () => {
		const api = new PullRequestApi(
			"PROJ",
			"repo",
			123,
			async () =>
				({
					id: 123,
					version: 7,
					state: "MERGED",
					title: "Merged PR",
					description: null,
					fromRef: {
						id: "refs/heads/feature",
						displayId: "feature",
						latestCommit: "head-123",
						repository: {
							id: 1,
							slug: "repo",
							project: { key: "PROJ" },
						},
					},
					toRef: {
						id: "refs/heads/main",
						displayId: "main",
						latestCommit: "base-123",
						repository: {
							id: 1,
							slug: "repo",
							project: { key: "PROJ" },
						},
					},
				}) as never,
		);

		const result = await api.getPullRequest();

		assert.equal(result.state, "MERGED");
	});

	it("preserves the draft flag for downstream review guards", async () => {
		const api = new PullRequestApi(
			"PROJ",
			"repo",
			123,
			async () =>
				({
					id: 123,
					version: 7,
					state: "OPEN",
					draft: true,
					title: "Draft PR",
					description: null,
					fromRef: {
						id: "refs/heads/feature",
						displayId: "feature",
						latestCommit: "head-123",
						repository: {
							id: 1,
							slug: "repo",
							project: { key: "PROJ" },
						},
					},
					toRef: {
						id: "refs/heads/main",
						displayId: "main",
						latestCommit: "base-123",
						repository: {
							id: 1,
							slug: "repo",
							project: { key: "PROJ" },
						},
					},
				}) as never,
		);

		const result = await api.getPullRequest();

		assert.equal(result.draft, true);
	});
});

describe("RepositoryPullRequestApi", () => {
	it("lists open pull requests across paginated responses", async () => {
		const requestedPaths: string[] = [];
		const api = new RepositoryPullRequestApi(
			"PROJ",
			"repo",
			async (pathname) => {
				requestedPaths.push(pathname);
				if (pathname.includes("start=0")) {
					return {
						values: [
							{
								id: 101,
								version: 1,
								state: "OPEN",
								title: "PR One",
								description: " first ",
								fromRef: {
									id: "refs/heads/a",
									displayId: "a",
									latestCommit: "head-a",
									repository: {
										id: 1,
										slug: "repo",
										project: { key: "PROJ" },
									},
								},
								toRef: {
									id: "refs/heads/main",
									displayId: "main",
									latestCommit: "base-a",
									repository: {
										id: 1,
										slug: "repo",
										project: { key: "PROJ" },
									},
								},
							},
						],
						isLastPage: false,
						nextPageStart: 25,
					} as never;
				}

				return {
					values: [
						{
							id: 102,
							version: 2,
							state: "OPEN",
							title: "PR Two",
							description: null,
							fromRef: {
								id: "refs/heads/b",
								displayId: "b",
								latestCommit: "head-b",
								repository: {
									id: 1,
									slug: "repo",
									project: { key: "PROJ" },
								},
							},
							toRef: {
								id: "refs/heads/main",
								displayId: "main",
								latestCommit: "base-b",
								repository: {
									id: 1,
									slug: "repo",
									project: { key: "PROJ" },
								},
							},
						},
					],
					isLastPage: true,
				} as never;
			},
		);

		const result = await api.listOpenPullRequests();

		assert.deepEqual(requestedPaths, [
			"/rest/api/latest/projects/PROJ/repos/repo/pull-requests?limit=1000&start=0&state=OPEN",
			"/rest/api/latest/projects/PROJ/repos/repo/pull-requests?limit=1000&start=25&state=OPEN",
		]);
		assert.equal(result.length, 2);
		assert.equal(result[0]?.id, 101);
		assert.equal(result[0]?.description, "first");
		assert.equal(result[0]?.draft, undefined);
		assert.equal(result[1]?.id, 102);
	});
});

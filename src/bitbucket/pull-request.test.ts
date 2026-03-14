import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PullRequestApi } from "./pull-request.ts";

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
	});
});

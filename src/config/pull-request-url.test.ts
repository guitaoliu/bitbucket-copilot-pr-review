import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseBitbucketPullRequestUrl } from "./pull-request-url.ts";

describe("parseBitbucketPullRequestUrl", () => {
	it("parses pull request urls with optional query and hash", () => {
		assert.deepEqual(
			parseBitbucketPullRequestUrl(
				"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123/?foo=1#activity",
			),
			{
				baseUrl: "https://bitbucket.example.com",
				projectKey: "PROJ",
				repoSlug: "repo",
				prId: 123,
			},
		);
	});

	it("parses pull request urls from Bitbucket PR tabs", () => {
		const tabUrls = [
			"https://bitbucket.example.com:8443/projects/PROJ/repos/repo/pull-requests/13616/overview",
			"https://bitbucket.example.com:8443/projects/PROJ/repos/repo/pull-requests/13616/diff#src%2Fcomponents%2FPermissionsEditor.tsx",
			"https://bitbucket.example.com:8443/projects/PROJ/repos/repo/pull-requests/13616/commits",
			"https://bitbucket.example.com:8443/projects/PROJ/repos/repo//pull-requests/13616/builds",
		];

		for (const tabUrl of tabUrls) {
			assert.deepEqual(parseBitbucketPullRequestUrl(tabUrl), {
				baseUrl: "https://bitbucket.example.com:8443",
				projectKey: "PROJ",
				repoSlug: "repo",
				prId: 13616,
			});
		}
	});

	it("keeps a path prefix in the base url", () => {
		const parsed = parseBitbucketPullRequestUrl(
			"https://host.example.com:8443/bitbucket/projects/PROJ/repos/repo/pull-requests/123",
		);

		assert.equal(parsed.baseUrl, "https://host.example.com:8443/bitbucket");
	});

	it("rejects non-pull-request urls", () => {
		assert.throws(
			() =>
				parseBitbucketPullRequestUrl(
					"https://bitbucket.example.com/projects/PROJ/repos/repo",
				),
			/Pull request URL must point to a pull request page/,
		);
	});

	it("rejects non-numeric pull request ids", () => {
		assert.throws(
			() =>
				parseBitbucketPullRequestUrl(
					"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/0",
				),
			/Pull request URL must include a numeric pull request id\./,
		);
	});

	it("rejects non-http urls", () => {
		assert.throws(
			() =>
				parseBitbucketPullRequestUrl(
					"ftp://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/1",
				),
			/Pull request URL must use http or https\./,
		);
	});
});

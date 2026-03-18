import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildConfigReferenceMarkdown } from "./docs.ts";

describe("buildConfigReferenceMarkdown", () => {
	it("renders generated CLI and environment tables", () => {
		const markdown = buildConfigReferenceMarkdown();

		assert.match(markdown, /## Configuration Reference/);
		assert.match(markdown, /### Review command/);
		assert.match(markdown, /### Batch command/);
		assert.match(
			markdown,
			/Review one pull request from an explicit Bitbucket URL/,
		);
		assert.match(
			markdown,
			/Review all open pull requests for one Bitbucket repository URL/,
		);
		assert.match(
			markdown,
			/Usage: `bitbucket-copilot-pr-review review <pull-request-url> \[options\]`/,
		);
		assert.match(
			markdown,
			/Usage: `bitbucket-copilot-pr-review batch <repository-url> \[options\]`/,
		);
		assert.doesNotMatch(markdown, /`BITBUCKET_BASE_URL`/);
		assert.doesNotMatch(markdown, /`BITBUCKET_PROJECT_KEY`/);
		assert.doesNotMatch(markdown, /`BITBUCKET_REPO_SLUG`/);
		assert.doesNotMatch(markdown, /`BITBUCKET_PR_ID`/);
		assert.match(markdown, /`REPORT_COMMENT_STRATEGY`/);
		assert.doesNotMatch(markdown, /`COPILOT_GITHUB_TOKEN`/);
		assert.match(markdown, /Argument: `<pull-request-url>`/);
		assert.match(markdown, /Argument: `<repository-url>`/);
		assert.match(
			markdown,
			/Bitbucket repository URL, for example https:\/\/host\/projects\/AAAS\/repos\/sbp/,
		);
	});
});

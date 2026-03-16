import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildConfigReferenceMarkdown } from "./docs.ts";

describe("buildConfigReferenceMarkdown", () => {
	it("renders generated CLI and environment tables", () => {
		const markdown = buildConfigReferenceMarkdown();

		assert.match(markdown, /## Configuration Reference/);
		assert.match(markdown, /`--dry-run`, `--no-publish`/);
		assert.match(markdown, /`--repo-id <project\/repo>`/);
		assert.match(markdown, /`BITBUCKET_BASE_URL`/);
		assert.match(markdown, /`REPORT_COMMENT_STRATEGY`/);
		assert.match(markdown, /### Batch review mode/);
	});
});

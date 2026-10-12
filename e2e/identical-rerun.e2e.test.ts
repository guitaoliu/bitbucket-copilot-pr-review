import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { assertSucceeded, countRequests } from "./support/assertions.ts";
import {
	type ReviewScenario,
	startReviewScenario,
} from "./support/scenario.ts";

describe("review CLI forced rerun with an identical result", {
	timeout: 180_000,
}, () => {
	let scenario: ReviewScenario;

	before(async () => {
		scenario = await startReviewScenario();
	});

	after(async () => {
		await scenario?.close();
	});

	it("republishes the report without creating, editing, or deleting comments", async () => {
		const { bitbucket } = scenario;
		assert.equal(
			assertSucceeded(await scenario.review()).publicationStatus,
			"published",
		);
		const commentsBefore = structuredClone([...bitbucket.comments.values()]);
		const requestsBefore = bitbucket.requests.length;

		const output = assertSucceeded(await scenario.review(["--force-review"]));

		assert.equal(output.skipped, false);
		assert.equal(output.publicationStatus, "published");
		const runRequests = bitbucket.requests.slice(requestsBefore);
		assert.equal(countRequests(runRequests, /^PUT .*\/reports\//), 1);
		assert.equal(
			countRequests(runRequests, /^(POST|PUT|DELETE) .*\/comments\b/),
			0,
		);
		assert.deepEqual([...bitbucket.comments.values()], commentsBefore);
	});
});

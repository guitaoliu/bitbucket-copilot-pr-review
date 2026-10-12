import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { assertSucceeded, countRequests } from "./support/assertions.ts";
import {
	type ReviewScenario,
	startReviewScenario,
} from "./support/scenario.ts";

describe("review CLI after a developer resolves a finding thread", {
	timeout: 180_000,
}, () => {
	let scenario: ReviewScenario;

	before(async () => {
		scenario = await startReviewScenario();
	});

	after(async () => {
		await scenario?.close();
	});

	it("does not re-post the finding when the head moves and the code is unchanged", async () => {
		const { bitbucket } = scenario;
		assert.equal(
			assertSucceeded(await scenario.review()).publicationStatus,
			"published",
		);
		const [finding, ...otherFindings] = [...bitbucket.comments.values()].filter(
			(comment) => comment.anchor,
		);
		assert.ok(finding);
		assert.deepEqual(otherFindings, []);
		finding.threadResolved = true;
		const resolved = structuredClone(finding);
		const requestsBefore = bitbucket.requests.length;
		scenario.pushHeadCommit({ "README.md": "Usage notes.\n" });

		const output = assertSucceeded(await scenario.review());

		assert.equal(output.publicationStatus, "published");
		assert.deepEqual(
			output.review.findings.map(({ line }) => line),
			[2],
		);
		assert.deepEqual(
			[...bitbucket.comments.values()].filter((comment) => comment.anchor),
			[resolved],
		);
		assert.equal(
			countRequests(
				bitbucket.requests.slice(requestsBefore),
				new RegExp(`/comments/${finding.id}\\b`),
			),
			0,
		);
	});
});

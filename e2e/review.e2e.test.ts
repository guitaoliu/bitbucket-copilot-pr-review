import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
	assertNoSecretsSentToModel,
	assertSucceeded,
	BITBUCKET_WRITE_REQUEST,
	countRequests,
	findingLocations,
	serializeMessages,
} from "./support/assertions.ts";
import { USER_INSTRUCTION_MARKER } from "./support/review-cli.ts";
import {
	type ReviewScenario,
	startReviewScenario,
} from "./support/scenario.ts";
import {
	BASE_GUIDANCE_MARKER,
	RUNTIME_INSTRUCTION_MARKERS,
} from "./support/target-repository.ts";

describe("review CLI end to end", { timeout: 180_000 }, () => {
	let scenario: ReviewScenario;

	before(async () => {
		scenario = await startReviewScenario();
	});

	after(async () => {
		await scenario?.close();
	});

	it("publishes the validated finding without exposing secret-bearing files to the model", async () => {
		const { bitbucket, model } = scenario;
		const output = assertSucceeded(await scenario.review());

		assert.equal(output.publicationStatus, "published");
		assert.deepEqual(findingLocations(output), [
			{ path: "src/app.js", line: 2 },
		]);
		assertNoSecretsSentToModel(model);
		assert.equal(countRequests(bitbucket.requests, /^PUT .*\/reports\//), 1);
		assert.equal(countRequests(bitbucket.requests, /^DELETE /), 0);
		assert.deepEqual(
			[...bitbucket.comments.values()].map((comment) => comment.anchor),
			[{ path: "src/app.js", line: 2 }, undefined],
		);
		assert.ok(output.metrics?.gitTelemetry?.byOperation.show);
		assert.ok(output.metrics?.gitTelemetry?.byOperation.grep);
		assert.equal(output.metrics?.toolTelemetry?.completionFollowUps, 0);
	});

	it("delivers base guidance only through review_changes", () => {
		const { requests } = scenario.model;
		const systemMessages = serializeMessages(requests, "system");
		const toolMessages = serializeMessages(requests, "tool");
		const allMessages = serializeMessages(requests);

		assert.equal(systemMessages.includes(BASE_GUIDANCE_MARKER), false);
		assert.ok(toolMessages.includes(BASE_GUIDANCE_MARKER));
		for (const marker of [
			...RUNTIME_INSTRUCTION_MARKERS,
			USER_INSTRUCTION_MARKER,
		]) {
			assert.equal(allMessages.includes(marker), false, marker);
		}
	});

	it("skips an unchanged pull request without calling the model or writing to Bitbucket", async () => {
		const { bitbucket, model } = scenario;
		const modelRequestsBefore = model.requests.length;
		const bitbucketRequestsBefore = bitbucket.requests.length;

		const output = assertSucceeded(await scenario.review());

		assert.equal(output.skipped, true);
		assert.equal(model.requests.length, modelRequestsBefore);
		assert.equal(
			countRequests(
				bitbucket.requests.slice(bitbucketRequestsBefore),
				BITBUCKET_WRITE_REQUEST,
			),
			0,
		);
	});

	it("re-reviews a moved head and updates the existing finding comment in place", async () => {
		const { bitbucket, repository } = scenario;
		const findingComment = [...bitbucket.comments.values()].find(
			(comment) => comment.anchor,
		);
		bitbucket.pullRequest.headCommit = repository.pushHeadCommit({
			"README.md": "Usage notes.\n",
		});

		const output = assertSucceeded(await scenario.review());

		assert.equal(output.publicationStatus, "published");
		const anchored = [...bitbucket.comments.values()].filter(
			(comment) => comment.anchor,
		);
		assert.equal(anchored.length, 1);
		assert.equal(anchored[0]?.id, findingComment?.id);
		assert.equal(anchored[0]?.version, 1);
		assert.equal(bitbucket.comments.size, 2);
		assert.equal(bitbucket.reports.size, 2);
	});
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
	assertNoSecretsSentToModel,
	assertSucceeded,
	countRequests,
} from "./support/assertions.ts";
import type { FakeComment } from "./support/fake-bitbucket.ts";
import {
	type ReviewScenario,
	startReviewScenario,
} from "./support/scenario.ts";

const SUMMARY_MARKER = "<!-- copilot-pr-review -->";

describe("review CLI with paginated pull request activities", {
	timeout: 180_000,
}, () => {
	let scenario: ReviewScenario;
	let previousSummary: FakeComment;
	let staleFinding: FakeComment;
	let humanComments: FakeComment[];

	before(async () => {
		scenario = await startReviewScenario({ activityPageSize: 1 });
		const { bitbucket } = scenario;
		previousSummary = bitbucket.addComment(
			[
				SUMMARY_MARKER,
				"<!-- copilot-pr-review:revision:previous-revision -->",
				"## Copilot PR Review",
				"### What Changed\nAn earlier revision of this pull request.",
			].join("\n\n"),
		);
		staleFinding = bitbucket.addComment(
			[
				"<!-- copilot-pr-review:finding-thread:previous-thread -->",
				"**LOW · CODE_SMELL**",
				"**Finding from an earlier revision**",
			].join("\n\n"),
			{ anchor: { path: "src/app.js", line: 3 } },
		);
		humanComments = [
			bitbucket.addComment("Could you add a test for this?", {
				author: "alice",
			}),
			bitbucket.addComment("Looks reasonable to me.", { author: "bob" }),
		].map((comment) => structuredClone(comment));
	});

	after(async () => {
		await scenario?.close();
	});

	it("finds earlier review comments on later activity pages and retires them", async () => {
		const { bitbucket, model } = scenario;
		const staleText = staleFinding.text;

		const output = assertSucceeded(await scenario.review());

		assert.equal(output.publicationStatus, "published");
		assertNoSecretsSentToModel(model);
		const [
			retiredFinding,
			firstHuman,
			secondHuman,
			finding,
			summary,
			...extra
		] = [...bitbucket.comments.values()];
		assert.equal(bitbucket.comments.has(previousSummary.id), false);
		assert.equal(retiredFinding?.id, staleFinding.id);
		assert.equal(retiredFinding?.text, staleText);
		assert.equal(retiredFinding?.threadResolved, true);
		assert.match(
			retiredFinding?.comments[0]?.text ?? "",
			/^This finding no longer applies as of commit `[0-9a-f]{11}`\.$/,
		);
		assert.deepEqual([firstHuman, secondHuman], humanComments);
		assert.deepEqual(finding?.anchor, { path: "src/app.js", line: 2 });
		assert.ok(summary?.text.includes(SUMMARY_MARKER));
		assert.equal(summary?.text.includes("previous-revision"), false);
		assert.deepEqual(extra, []);
		assert.ok(
			countRequests(bitbucket.requests, /^GET .*\/activities\?.*start=3\b/) > 0,
		);
	});
});

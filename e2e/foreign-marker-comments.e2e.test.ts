import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { assertSucceeded, countRequests } from "./support/assertions.ts";
import { BOT_USER_NAME, type FakeComment } from "./support/fake-bitbucket.ts";
import {
	type ReviewScenario,
	startReviewScenario,
} from "./support/scenario.ts";

describe("review CLI with comments that quote the bot's markers", {
	timeout: 180_000,
}, () => {
	let scenario: ReviewScenario;
	let quotedComments: FakeComment[];

	before(async () => {
		scenario = await startReviewScenario();
		const { bitbucket } = scenario;
		quotedComments = [
			bitbucket.addComment(
				[
					"Pasting the old bot summary for reference:",
					"<!-- copilot-pr-review -->",
					"<!-- copilot-pr-review:revision:old-revision -->",
					"## Copilot PR Review",
				].join("\n"),
				{ author: "alice" },
			),
			bitbucket.addComment(
				[
					"<!-- copilot-pr-review:finding-key:0000000000000000 -->",
					"<!-- copilot-pr-review:finding-code:0000000000000000 -->",
					"I disagree with this automated finding.",
				].join("\n"),
				{ anchor: { path: "src/app.js", line: 3 }, author: "alice" },
			),
			bitbucket.addComment(
				"<!-- copilot-pr-review:finding-thread:thread-old -->\nQuoted thread.",
				{ author: "bob" },
			),
		].map((comment) => structuredClone(comment));
	});

	after(async () => {
		await scenario?.close();
	});

	it("never modifies, deletes, or replies to comments other users wrote", async () => {
		const { bitbucket } = scenario;

		const output = assertSucceeded(await scenario.review());

		assert.equal(output.publicationStatus, "published");
		assert.deepEqual(
			quotedComments.map((comment) => bitbucket.comments.get(comment.id)),
			quotedComments,
		);
		for (const { id } of quotedComments) {
			assert.equal(
				countRequests(bitbucket.requests, new RegExp(`/comments/${id}\\b`)),
				0,
			);
		}
		const botComments = [...bitbucket.comments.values()].filter(
			(comment) => comment.author.name === BOT_USER_NAME,
		);
		assert.deepEqual(
			botComments.map((comment) => comment.anchor),
			[{ path: "src/app.js", line: 2 }, undefined],
		);
	});
});

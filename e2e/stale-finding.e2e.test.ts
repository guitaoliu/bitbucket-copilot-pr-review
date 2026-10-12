import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { assertSucceeded, countRequests } from "./support/assertions.ts";
import {
	type ReviewScenario,
	startReviewScenario,
} from "./support/scenario.ts";
import {
	READ_CHANGED_FILE_CALL,
	RECORD_SUMMARY_CALL,
} from "./support/scripted-reviewer.ts";

describe("review CLI after the flagged code changes", {
	timeout: 180_000,
}, () => {
	let scenario: ReviewScenario;

	before(async () => {
		scenario = await startReviewScenario();
	});

	after(async () => {
		await scenario?.close();
	});

	it("replies to and resolves the finding that no longer applies instead of deleting it", async () => {
		const { bitbucket } = scenario;
		assert.equal(
			assertSucceeded(await scenario.review()).publicationStatus,
			"published",
		);
		const finding = [...bitbucket.comments.values()].find(
			(comment) => comment.anchor,
		);
		assert.ok(finding);
		const originalText = finding.text;
		const headCommit = scenario.pushHeadCommit({
			"src/app.js":
				"export function same(a, b) {\n\tif (a === b) {\n\t\treturn true;\n\t}\n\treturn false;\n}\n",
		});
		scenario.scriptReviewer({
			toolCalls: [READ_CHANGED_FILE_CALL, RECORD_SUMMARY_CALL],
		});
		const requestsBefore = bitbucket.requests.length;

		const output = assertSucceeded(await scenario.review());

		assert.equal(output.publicationStatus, "published");
		assert.deepEqual(output.review.findings, []);
		const retired = bitbucket.comments.get(finding.id);
		assert.equal(retired?.text, originalText);
		assert.equal(retired?.threadResolved, true);
		assert.deepEqual(
			retired?.comments.map((reply) => reply.text),
			[
				`This finding no longer applies as of commit \`${headCommit.slice(0, 11)}\`.`,
			],
		);
		assert.equal(
			countRequests(
				bitbucket.requests.slice(requestsBefore),
				new RegExp(`^DELETE .*/comments/${finding.id}\\b`),
			),
			0,
		);
		assert.equal(
			[...bitbucket.comments.values()].filter((comment) => comment.anchor)
				.length,
			1,
		);
	});
});

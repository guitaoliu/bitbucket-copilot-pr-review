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
	VALID_FINDING_ARGS,
} from "./support/scripted-reviewer.ts";

describe("review CLI after an unrelated edit shifts a finding's line", {
	timeout: 180_000,
}, () => {
	let scenario: ReviewScenario;

	before(async () => {
		scenario = await startReviewScenario();
	});

	after(async () => {
		await scenario?.close();
	});

	it("keeps the existing finding comment and its discussion", async () => {
		const { bitbucket } = scenario;
		assert.equal(
			assertSucceeded(await scenario.review()).publicationStatus,
			"published",
		);
		const finding = [...bitbucket.comments.values()].find(
			(comment) => comment.anchor,
		);
		assert.ok(finding);
		scenario.pushHeadCommit({
			"src/app.js":
				"// Compares two values.\nexport function same(a, b) {\n\tif (a == b) {\n\t\treturn true;\n\t}\n\treturn false;\n}\n",
		});
		scenario.scriptReviewer({
			toolCalls: [
				READ_CHANGED_FILE_CALL,
				{ name: "emit_finding", args: { ...VALID_FINDING_ARGS, line: 3 } },
				RECORD_SUMMARY_CALL,
			],
		});
		const requestsBefore = bitbucket.requests.length;

		const output = assertSucceeded(await scenario.review());

		assert.equal(output.publicationStatus, "published");
		assert.deepEqual(
			output.review.findings.map(({ line }) => line),
			[3],
		);
		const anchored = [...bitbucket.comments.values()].filter(
			(comment) => comment.anchor,
		);
		assert.deepEqual(
			anchored.map(({ id }) => id),
			[finding.id],
		);
		assert.match(anchored[0]?.text ?? "", /Location: `src\/app\.js:3`/);
		const runRequests = bitbucket.requests.slice(requestsBefore);
		assert.equal(
			countRequests(
				runRequests,
				new RegExp(`^DELETE .*/comments/${finding.id}\\b`),
			),
			0,
		);
		assert.equal(
			countRequests(runRequests, new RegExp(`^PUT .*/comments/${finding.id}$`)),
			1,
		);
	});
});

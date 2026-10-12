import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
	BITBUCKET_WRITE_REQUEST,
	countRequests,
} from "./support/assertions.ts";
import {
	type ReviewScenario,
	startReviewScenario,
} from "./support/scenario.ts";
import {
	EMIT_VALID_FINDING_CALL,
	RECORD_SUMMARY_CALL,
} from "./support/scripted-reviewer.ts";

describe("review CLI without the mandatory review stream", {
	timeout: 180_000,
}, () => {
	let scenario: ReviewScenario;

	before(async () => {
		scenario = await startReviewScenario({
			reviewer: {
				skipReviewChanges: true,
				toolCalls: [EMIT_VALID_FINDING_CALL, RECORD_SUMMARY_CALL],
			},
		});
	});

	after(async () => {
		await scenario?.close();
	});

	it("fails closed without publishing a report or comment", async () => {
		const { bitbucket, model } = scenario;

		const run = await scenario.review();

		const calledTools = (model.requests.at(-1)?.messages ?? [])
			.flatMap((message) => message.tool_calls ?? [])
			.map((call) => call.function.name);
		assert.deepEqual(calledTools, ["emit_finding", "record_pr_summary"]);
		assert.equal(run.exitCode, 1);
		assert.equal(run.output, undefined);
		assert.match(
			run.stderr,
			/Copilot review stopped because review_changes delivered 0\/(\d+|\?) required pages\./,
		);
		assert.equal(countRequests(bitbucket.requests, BITBUCKET_WRITE_REQUEST), 0);
		assert.equal(bitbucket.comments.size, 0);
		assert.equal(bitbucket.reports.size, 0);
	});
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
	assertNoSecretsSentToModel,
	assertSucceeded,
	findingLocations,
} from "./support/assertions.ts";
import {
	type ReviewScenario,
	startReviewScenario,
} from "./support/scenario.ts";
import {
	EMIT_VALID_FINDING_CALL,
	READ_CHANGED_FILE_CALL,
	RECORD_SUMMARY_CALL,
	SECRET_PROBE_CALLS,
	VALID_FINDING_ARGS,
} from "./support/scripted-reviewer.ts";

describe("review CLI after invalid tool arguments", {
	timeout: 180_000,
}, () => {
	let scenario: ReviewScenario;

	before(async () => {
		scenario = await startReviewScenario({
			reviewer: {
				toolCalls: [
					{ name: "read_file", args: { path: "src/app.js" } },
					READ_CHANGED_FILE_CALL,
					...SECRET_PROBE_CALLS,
					{
						name: "emit_finding",
						args: { ...VALID_FINDING_ARGS, severity: "URGENT" },
					},
					EMIT_VALID_FINDING_CALL,
					RECORD_SUMMARY_CALL,
				],
			},
		});
	});

	after(async () => {
		await scenario?.close();
	});

	it("feeds the rejection back to the model and publishes the corrected finding", async () => {
		const { bitbucket, model } = scenario;

		const output = assertSucceeded(await scenario.review());

		assert.equal(output.publicationStatus, "published");
		assert.deepEqual(findingLocations(output), [
			{ path: "src/app.js", line: 2 },
		]);
		assertNoSecretsSentToModel(model);
		assert.deepEqual(
			[...bitbucket.comments.values()].map((comment) => comment.anchor),
			[{ path: "src/app.js", line: 2 }, undefined],
		);
		const byTool = output.metrics?.toolTelemetry?.byTool;
		assert.deepEqual(byTool?.emit_finding?.resultCounts, {
			rejected: 1,
			success: 1,
		});
		assert.deepEqual(byTool?.read_file?.resultCounts, {
			rejected: 3,
			success: 1,
		});

		const transcript = model.requests.at(-1)?.messages ?? [];
		const invalidCallIds = transcript
			.flatMap((message) => message.tool_calls ?? [])
			.filter(({ function: { name, arguments: rawArgs } }) => {
				const args = JSON.parse(rawArgs);
				return name === "read_file"
					? args.revision === undefined
					: args.severity === "URGENT";
			})
			.map((call) => call.id);
		const feedback = transcript
			.filter(
				(message) =>
					message.role === "tool" &&
					invalidCallIds.includes(message.tool_call_id ?? ""),
			)
			.map((message) => JSON.stringify(message.content));
		assert.equal(feedback.length, 2);
		assert.match(feedback[0] ?? "", /Invalid read_file arguments.*at revision/);
		assert.match(
			feedback[1] ?? "",
			/Invalid emit_finding arguments.*at severity/,
		);
	});
});

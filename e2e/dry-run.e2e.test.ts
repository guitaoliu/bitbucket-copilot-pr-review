import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
	assertNoSecretsSentToModel,
	assertSucceeded,
	BITBUCKET_WRITE_REQUEST,
	countRequests,
	findingLocations,
} from "./support/assertions.ts";
import {
	type ReviewScenario,
	startReviewScenario,
} from "./support/scenario.ts";

describe("review CLI dry run", { timeout: 180_000 }, () => {
	let scenario: ReviewScenario;

	before(async () => {
		scenario = await startReviewScenario();
	});

	after(async () => {
		await scenario?.close();
	});

	it("reports findings on stdout without writing anything to Bitbucket", async () => {
		const { bitbucket, model } = scenario;

		const output = assertSucceeded(await scenario.review(["--dry-run"]));

		assert.equal(output.publicationStatus, "dry_run");
		assert.deepEqual(findingLocations(output), [
			{ path: "src/app.js", line: 2 },
		]);
		assertNoSecretsSentToModel(model);
		assert.equal(countRequests(bitbucket.requests, BITBUCKET_WRITE_REQUEST), 0);
		assert.equal(bitbucket.comments.size, 0);
		assert.equal(bitbucket.reports.size, 0);
	});
});

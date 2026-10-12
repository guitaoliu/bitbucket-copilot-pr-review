import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
	type FakeBitbucket,
	startFakeBitbucket,
} from "./support/fake-bitbucket.ts";
import {
	type ChatCompletionRequest,
	type FakeModel,
	startFakeModel,
} from "./support/fake-model.ts";
import { type ReviewCliRun, runReviewCli } from "./support/review-cli.ts";
import { nextReviewerStep } from "./support/scripted-reviewer.ts";
import {
	BASE_GUIDANCE_MARKER,
	createTargetRepository,
	RUNTIME_INSTRUCTION_MARKERS,
	SECRET_VALUES,
	type TargetRepository,
} from "./support/target-repository.ts";

interface ReviewOutput {
	skipped: boolean;
	publicationStatus?: string;
	review: { findings: Array<{ path: string; line: number }> };
	metrics?: { gitTelemetry?: { byOperation: Record<string, unknown> } };
}

function assertSucceeded(run: ReviewCliRun): ReviewOutput {
	assert.equal(
		run.exitCode,
		0,
		`review CLI failed:\n${run.stderr.split("\n").slice(-20).join("\n")}`,
	);
	assert.ok(run.output, `stdout was not JSON:\n${run.stdout}`);
	return run.output as unknown as ReviewOutput;
}

function serializeMessages(
	requests: ChatCompletionRequest[],
	role?: string,
): string {
	return JSON.stringify(
		requests.flatMap((request) =>
			(request.messages ?? []).filter(
				(message) => role === undefined || message.role === role,
			),
		),
	);
}

function countRequests(requests: string[], pattern: RegExp): number {
	return requests.filter((request) => pattern.test(request)).length;
}

describe("review CLI end to end", { timeout: 180_000 }, () => {
	let repository: TargetRepository;
	let model: FakeModel;
	let bitbucket: FakeBitbucket;
	const review = () =>
		runReviewCli({
			repoRoot: repository.root,
			pullRequestUrl: bitbucket.pullRequestUrl,
			modelUrl: model.url,
		});

	before(async () => {
		repository = createTargetRepository();
		model = await startFakeModel(nextReviewerStep);
		bitbucket = await startFakeBitbucket({
			projectKey: "PROJ",
			repoSlug: "repo",
			id: 7,
			baseCommit: repository.baseCommit,
			headCommit: repository.headCommit,
		});
	});

	after(async () => {
		await model?.close();
		await bitbucket?.close();
		repository?.cleanup();
	});

	it("publishes the validated finding without exposing secret-bearing files to the model", async () => {
		const output = assertSucceeded(await review());

		assert.equal(output.publicationStatus, "published");
		assert.deepEqual(
			output.review.findings.map(({ path, line }) => ({ path, line })),
			[{ path: "src/app.js", line: 2 }],
		);
		const modelTraffic = JSON.stringify(model.requests);
		for (const secret of SECRET_VALUES) {
			assert.equal(modelTraffic.includes(secret), false, secret);
		}
		assert.equal(countRequests(bitbucket.requests, /^PUT .*\/reports\//), 1);
		assert.equal(countRequests(bitbucket.requests, /^DELETE /), 0);
		assert.deepEqual(
			[...bitbucket.comments.values()].map((comment) => comment.anchor),
			[{ path: "src/app.js", line: 2 }, undefined],
		);
		assert.ok(output.metrics?.gitTelemetry?.byOperation.show);
		assert.ok(output.metrics?.gitTelemetry?.byOperation.grep);
	});

	it("delivers base guidance only through review_changes", () => {
		const systemMessages = serializeMessages(model.requests, "system");
		const toolMessages = serializeMessages(model.requests, "tool");
		const allMessages = serializeMessages(model.requests);

		assert.equal(systemMessages.includes(BASE_GUIDANCE_MARKER), false);
		assert.ok(toolMessages.includes(BASE_GUIDANCE_MARKER));
		for (const marker of RUNTIME_INSTRUCTION_MARKERS) {
			assert.equal(allMessages.includes(marker), false, marker);
		}
	});

	it("skips an unchanged pull request without calling the model or writing to Bitbucket", async () => {
		const modelRequestsBefore = model.requests.length;
		const bitbucketRequestsBefore = bitbucket.requests.length;

		const output = assertSucceeded(await review());

		assert.equal(output.skipped, true);
		assert.equal(model.requests.length, modelRequestsBefore);
		assert.equal(
			countRequests(
				bitbucket.requests.slice(bitbucketRequestsBefore),
				/^(PUT|POST|DELETE) /,
			),
			0,
		);
	});

	it("re-reviews a moved head and updates the existing finding comment in place", async () => {
		const findingComment = [...bitbucket.comments.values()].find(
			(comment) => comment.anchor,
		);
		bitbucket.pullRequest.headCommit = repository.pushHeadCommit({
			"README.md": "Usage notes.\n",
		});

		const output = assertSucceeded(await review());

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

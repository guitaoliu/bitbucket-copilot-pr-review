import assert from "node:assert/strict";

import type { ChatCompletionRequest, FakeModel } from "./fake-model.ts";
import type { ReviewCliRun } from "./review-cli.ts";
import { SECRET_VALUES } from "./target-repository.ts";

export const BITBUCKET_WRITE_REQUEST = /^(PUT|POST|DELETE) /;

export interface ReviewOutput {
	skipped: boolean;
	publicationStatus?: string;
	review: { findings: Array<{ path: string; line: number }> };
	metrics?: {
		gitTelemetry?: { byOperation: Record<string, unknown> };
		toolTelemetry?: {
			completionFollowUps: number;
			byTool: Record<string, { resultCounts: Record<string, number> }>;
		};
	};
}

export function assertSucceeded(run: ReviewCliRun): ReviewOutput {
	assert.equal(
		run.exitCode,
		0,
		`review CLI failed:\n${run.stderr.split("\n").slice(-20).join("\n")}`,
	);
	assert.ok(run.output, `stdout was not JSON:\n${run.stdout}`);
	return run.output as unknown as ReviewOutput;
}

export function assertNoSecretsSentToModel(model: FakeModel): void {
	assert.ok(model.requests.length > 0, "the model was never called");
	const modelTraffic = JSON.stringify(model.requests);
	for (const secret of SECRET_VALUES) {
		assert.equal(modelTraffic.includes(secret), false, secret);
	}
}

export function findingLocations(
	output: ReviewOutput,
): Array<{ path: string; line: number }> {
	return output.review.findings.map(({ path, line }) => ({ path, line }));
}

export function serializeMessages(
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

export function countRequests(requests: string[], pattern: RegExp): number {
	return requests.filter((request) => pattern.test(request)).length;
}

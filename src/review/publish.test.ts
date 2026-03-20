import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewerConfig } from "../config/types.ts";
import {
	baseReviewerConfig,
	createLoggerSpy,
	createPullRequest,
	createReviewArtifacts,
	createReviewContext,
	createReviewOutcome,
} from "../test-support/review-fixtures.ts";
import { publishReview } from "./publish.ts";
import type { ReviewBitbucketClient } from "./runner-types.ts";

function createBitbucketClient(
	overrides: Partial<ReviewBitbucketClient> = {},
): ReviewBitbucketClient {
	return {
		async getPullRequest() {
			return createPullRequest();
		},
		async getCodeInsightsReport() {
			return undefined;
		},
		async listCodeInsightsAnnotations() {
			return [];
		},
		async getCodeInsightsAnnotationCount() {
			return 0;
		},
		async findPullRequestCommentByTag() {
			return undefined;
		},
		async publishCodeInsights() {},
		async upsertPullRequestComment() {},
		...overrides,
	};
}

describe("publishReview", () => {
	it("returns early without touching Bitbucket when dry run is enabled", async () => {
		const config: ReviewerConfig = {
			...baseReviewerConfig,
			review: {
				...baseReviewerConfig.review,
				dryRun: true,
			},
		};
		let pullRequestCalls = 0;
		const { logger, infoMessages, warnMessages, errorMessages } =
			createLoggerSpy();
		const result = await publishReview(
			createBitbucketClient({
				async getPullRequest() {
					pullRequestCalls += 1;
					return createPullRequest();
				},
			}),
			config,
			createReviewContext(createPullRequest()),
			createReviewOutcome(),
			createReviewArtifacts(),
			logger,
		);

		assert.deepEqual(result, {
			published: false,
			publication: {
				status: "dry_run",
				attempted: false,
				codeInsightsPublished: false,
				pullRequestCommentUpdated: false,
			},
			review: createReviewOutcome(),
		});
		assert.equal(pullRequestCalls, 0);
		assert.deepEqual(infoMessages, [
			"Dry run enabled, skipping Bitbucket Code Insights publish.",
		]);
		assert.deepEqual(warnMessages, []);
		assert.deepEqual(errorMessages, []);
	});

	it("marks the review stale when the pull request head moves before publish", async () => {
		const pr = createPullRequest("head-123");
		const context = createReviewContext(pr);
		const review = createReviewOutcome();
		const { logger, warnMessages } = createLoggerSpy();
		let publishCalled = false;
		let commentCalled = false;
		const result = await publishReview(
			createBitbucketClient({
				async getPullRequest() {
					return createPullRequest("head-456");
				},
				async publishCodeInsights() {
					publishCalled = true;
				},
				async upsertPullRequestComment() {
					commentCalled = true;
				},
			}),
			baseReviewerConfig,
			context,
			review,
			createReviewArtifacts(),
			logger,
		);

		assert.deepEqual(result, {
			published: false,
			publication: {
				status: "stale",
				attempted: false,
				codeInsightsPublished: false,
				pullRequestCommentUpdated: false,
			},
			review: {
				...review,
				stale: true,
			},
		});
		assert.equal(publishCalled, false);
		assert.equal(commentCalled, false);
		assert.match(
			warnMessages[0] ?? "",
			/Skipping publish because the PR head moved from head-123 to head-456/,
		);
	});

	it("publishes insights and updates the tagged comment for the current head", async () => {
		const pr = createPullRequest();
		const context = createReviewContext(pr);
		const review = createReviewOutcome();
		const artifacts = createReviewArtifacts();
		const publishCalls: Array<{
			commitId: string;
			reportKey: string;
			report: ReturnType<typeof createReviewArtifacts>["report"];
			annotations: ReturnType<typeof createReviewArtifacts>["annotations"];
		}> = [];
		const commentCalls: Array<{
			tag: string;
			text: string;
			strategy: ReviewerConfig["report"]["commentStrategy"] | undefined;
		}> = [];
		const { logger, warnMessages, errorMessages } = createLoggerSpy();
		const result = await publishReview(
			createBitbucketClient({
				async getPullRequest() {
					return pr;
				},
				async publishCodeInsights(commitId, reportKey, report, annotations) {
					publishCalls.push({ commitId, reportKey, report, annotations });
				},
				async upsertPullRequestComment(tag, text, options) {
					commentCalls.push({ tag, text, strategy: options?.strategy });
				},
			}),
			baseReviewerConfig,
			context,
			review,
			artifacts,
			logger,
		);

		assert.deepEqual(result, {
			published: true,
			publication: {
				status: "published",
				attempted: true,
				codeInsightsPublished: true,
				pullRequestCommentUpdated: true,
			},
			review,
		});
		assert.deepEqual(publishCalls, [
			{
				commitId: context.headCommit,
				reportKey: baseReviewerConfig.report.key,
				report: artifacts.report,
				annotations: artifacts.annotations,
			},
		]);
		assert.deepEqual(commentCalls, [
			{
				tag: baseReviewerConfig.report.commentTag,
				text: artifacts.commentBody,
				strategy: baseReviewerConfig.report.commentStrategy,
			},
		]);
		assert.deepEqual(warnMessages, []);
		assert.deepEqual(errorMessages, []);
	});

	it("returns a failed publication result when Code Insights publish fails", async () => {
		const { logger, errorMessages } = createLoggerSpy();
		const result = await publishReview(
			createBitbucketClient({
				async publishCodeInsights() {
					throw new Error("report unavailable");
				},
			}),
			baseReviewerConfig,
			createReviewContext(),
			createReviewOutcome(),
			createReviewArtifacts(),
			logger,
		);

		assert.equal(result.published, false);
		assert.deepEqual(result.publication, {
			status: "failed",
			attempted: true,
			codeInsightsPublished: false,
			pullRequestCommentUpdated: false,
			error: {
				stage: "code_insights",
				message: "report unavailable",
			},
		});
		assert.match(
			errorMessages[0] ?? "",
			/Bitbucket publication failed before the PR comment update/,
		);
	});

	it("returns a partial publication result when the PR comment update fails twice", async () => {
		let commentAttempts = 0;
		const { logger, warnMessages, errorMessages } = createLoggerSpy();
		const result = await publishReview(
			createBitbucketClient({
				async upsertPullRequestComment() {
					commentAttempts += 1;
					throw new Error(`comment failure ${commentAttempts}`);
				},
			}),
			baseReviewerConfig,
			createReviewContext(),
			createReviewOutcome(),
			createReviewArtifacts(),
			logger,
		);

		assert.equal(commentAttempts, 2);
		assert.equal(result.published, false);
		assert.deepEqual(result.publication, {
			status: "partial",
			attempted: true,
			codeInsightsPublished: true,
			pullRequestCommentUpdated: false,
			error: {
				stage: "pull_request_comment",
				message: "comment failure 2",
			},
		});
		assert.match(
			warnMessages[0] ?? "",
			/retrying before marking publication partial/,
		);
		assert.match(errorMessages[0] ?? "", /failed during PR comment update/);
	});
});

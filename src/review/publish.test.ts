import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
	PullRequestComment,
	PullRequestCommentDraft,
} from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import {
	baseReviewerConfig,
	createFakeBitbucketClient,
	createLoggerSpy,
	createPullRequest,
	createReviewArtifacts,
	createReviewContext,
	createReviewOutcome,
} from "../test-support/review-fixtures.ts";
import { publishReview } from "./publish.ts";

const summaryComment: PullRequestComment = {
	id: 1,
	version: 3,
	text: "<!-- copilot-pr-review -->\nold summary",
};
const findingComment: PullRequestComment = {
	id: 2,
	version: 1,
	text: "<!-- copilot-pr-review:finding-thread:thread-1 -->\nold finding",
};
const findingDraft: PullRequestCommentDraft = {
	keys: ["thread:thread-1"],
	text: "finding text",
	anchor: { path: "src/example.ts", line: 10 },
};

describe("publishReview", () => {
	it("blocks publication for an incomplete review without calling Bitbucket", async () => {
		let bitbucketCalls = 0;
		const count = async () => {
			bitbucketCalls += 1;
		};
		const { logger, warnMessages } = createLoggerSpy();
		const result = await publishReview(
			createFakeBitbucketClient({
				pullRequest: {
					getPullRequest: async () => {
						bitbucketCalls += 1;
						return createPullRequest();
					},
				},
				codeInsights: { putReport: count },
				comments: { upsertComment: count, reconcileKeyedComments: count },
			}),
			baseReviewerConfig,
			createReviewContext(),
			createReviewArtifacts(baseReviewerConfig, {
				review: createReviewOutcome({
					incomplete: {
						reason: "Repository context inspection was incomplete.",
						failedTools: ["search_repo"],
					},
				}),
			}),
			logger,
		);

		assert.equal(bitbucketCalls, 0);
		assert.deepEqual(result, {
			status: "failed",
			completedStages: [],
			error: {
				stage: "review",
				message: "Repository context inspection was incomplete.",
			},
		});
		assert.match(warnMessages[0] ?? "", /review is incomplete/);
	});

	it("returns early without touching Bitbucket when dry run is enabled", async () => {
		const config: ReviewerConfig = {
			...baseReviewerConfig,
			review: { ...baseReviewerConfig.review, dryRun: true },
		};
		let pullRequestCalls = 0;
		const result = await publishReview(
			createFakeBitbucketClient({
				pullRequest: {
					getPullRequest: async () => {
						pullRequestCalls += 1;
						return createPullRequest();
					},
				},
			}),
			config,
			createReviewContext(),
			createReviewArtifacts(),
			createLoggerSpy().logger,
		);

		assert.deepEqual(result, { status: "dry_run", completedStages: [] });
		assert.equal(pullRequestCalls, 0);
	});

	for (const [label, latest, expectedWarning] of [
		[
			"the head moves",
			createPullRequest("head-456"),
			/the PR head moved from head-123 to head-456/,
		],
		[
			"the base moves",
			{
				...createPullRequest(),
				target: { ...createPullRequest().target, latestCommit: "base-456" },
			},
			/the PR base moved from base-123 to base-456/,
		],
		[
			"the pull request is no longer open",
			{ ...createPullRequest(), state: "MERGED" },
			/pull request #123 is MERGED/,
		],
	] as const) {
		it(`marks the publication stale without writing when ${label}`, async () => {
			let writes = 0;
			const write = async () => {
				writes += 1;
			};
			const { logger, warnMessages } = createLoggerSpy();
			const result = await publishReview(
				createFakeBitbucketClient({
					pullRequest: { getPullRequest: async () => latest },
					codeInsights: { putReport: write },
					comments: { upsertComment: write, reconcileKeyedComments: write },
				}),
				baseReviewerConfig,
				createReviewContext(),
				createReviewArtifacts(),
				logger,
			);

			assert.deepEqual(result, { status: "stale", completedStages: [] });
			assert.equal(writes, 0);
			assert.match(warnMessages[0] ?? "", expectedWarning);
		});
	}

	it("publishes all stages from a single comment listing", async () => {
		const context = createReviewContext();
		const artifacts = createReviewArtifacts(baseReviewerConfig, {
			findingComments: [findingDraft],
		});
		const calls: string[] = [];
		let reconciled:
			| { existing: PullRequestComment[]; drafts: PullRequestCommentDraft[] }
			| undefined;
		let reconcileKeys: Array<string | undefined> = [];
		let upserted: { existing: PullRequestComment[]; text: string } | undefined;
		const result = await publishReview(
			createFakeBitbucketClient({
				codeInsights: {
					putReport: async (commitId, reportKey, report) => {
						calls.push("putReport");
						assert.equal(commitId, context.headCommit);
						assert.equal(reportKey, baseReviewerConfig.report.key);
						assert.equal(report, artifacts.report);
					},
				},
				comments: {
					listComments: async () => {
						calls.push("listComments");
						return [summaryComment, findingComment];
					},
					reconcileKeyedComments: async (existing, drafts, options) => {
						calls.push("reconcile");
						reconciled = { existing, drafts };
						reconcileKeys = existing.map((comment) =>
							options.keyOf(comment.text),
						);
					},
					upsertComment: async (existing, text, options) => {
						calls.push("upsert");
						assert.equal(
							options.strategy,
							baseReviewerConfig.report.commentStrategy,
						);
						upserted = { existing, text };
					},
				},
			}),
			baseReviewerConfig,
			context,
			artifacts,
			createLoggerSpy().logger,
		);

		assert.deepEqual(result, {
			status: "published",
			completedStages: [
				"code_insights",
				"finding_comments",
				"pull_request_comment",
			],
		});
		assert.deepEqual(calls, [
			"putReport",
			"listComments",
			"reconcile",
			"upsert",
		]);
		assert.deepEqual(reconciled, {
			existing: [summaryComment, findingComment],
			drafts: [findingDraft],
		});
		assert.deepEqual(reconcileKeys, [undefined, "thread:thread-1"]);
		assert.deepEqual(upserted, {
			existing: [summaryComment],
			text: artifacts.commentBody,
		});
	});

	it("fails without later stages when the Code Insights publish fails", async () => {
		let commentCalls = 0;
		const { logger, errorMessages } = createLoggerSpy();
		const result = await publishReview(
			createFakeBitbucketClient({
				codeInsights: {
					putReport: async () => {
						throw new Error("report unavailable");
					},
				},
				comments: {
					listComments: async () => {
						commentCalls += 1;
						return [];
					},
				},
			}),
			baseReviewerConfig,
			createReviewContext(),
			createReviewArtifacts(),
			logger,
		);

		assert.deepEqual(result, {
			status: "failed",
			completedStages: [],
			error: { stage: "code_insights", message: "report unavailable" },
		});
		assert.equal(commentCalls, 0);
		assert.match(errorMessages[0] ?? "", /failed at stage code_insights/);
	});

	it("is partial and skips the summary comment when finding comments fail", async () => {
		let summaryCommentCalled = false;
		const result = await publishReview(
			createFakeBitbucketClient({
				comments: {
					reconcileKeyedComments: async () => {
						throw new Error("finding comment failure");
					},
					upsertComment: async () => {
						summaryCommentCalled = true;
					},
				},
			}),
			baseReviewerConfig,
			createReviewContext(),
			createReviewArtifacts(),
			createLoggerSpy().logger,
		);

		assert.equal(summaryCommentCalled, false);
		assert.deepEqual(result, {
			status: "partial",
			completedStages: ["code_insights"],
			error: { stage: "finding_comments", message: "finding comment failure" },
		});
	});

	it("re-reads comments before retrying a failed summary comment update", async () => {
		const createdSummary: PullRequestComment = {
			id: 9,
			version: 0,
			text: "<!-- copilot-pr-review -->\nnew summary",
		};
		const listings = [[summaryComment], [createdSummary, summaryComment]];
		const upsertExisting: PullRequestComment[][] = [];
		const { logger, warnMessages } = createLoggerSpy();
		const result = await publishReview(
			createFakeBitbucketClient({
				comments: {
					listComments: async () => listings.shift() ?? [],
					upsertComment: async (existing) => {
						upsertExisting.push(existing);
						throw new Error(`comment failure ${upsertExisting.length}`);
					},
				},
			}),
			baseReviewerConfig,
			createReviewContext(),
			createReviewArtifacts(),
			logger,
		);

		assert.deepEqual(upsertExisting, [
			[summaryComment],
			[createdSummary, summaryComment],
		]);
		assert.deepEqual(result, {
			status: "partial",
			completedStages: ["code_insights", "finding_comments"],
			error: { stage: "pull_request_comment", message: "comment failure 2" },
		});
		assert.match(warnMessages[0] ?? "", /re-reading comments and retrying/);
	});
});

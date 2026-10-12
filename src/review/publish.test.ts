import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PullRequestComment } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import {
	baseReviewerConfig,
	createFakeBitbucketClient,
	createLoggerSpy,
	createPullRequest,
	createPullRequestComment,
	createReviewArtifacts,
	createReviewContext,
	createReviewOutcome,
} from "../test-support/review-fixtures.ts";
import type { FindingCommentDraft } from "./comment-sync.ts";
import { publishReview } from "./publish.ts";
import type { ReviewBitbucketClient } from "./runner-types.ts";

const summaryComment = createPullRequestComment({
	id: 1,
	version: 3,
	text: "<!-- copilot-pr-review -->\nold summary",
	createdDate: 100,
});
const findingComment = createPullRequestComment({
	id: 2,
	version: 1,
	text: "<!-- copilot-pr-review:finding-thread:thread-1 -->\nold finding",
	createdDate: 50,
});
const findingDraft: FindingCommentDraft = {
	keys: ["key:finding-1", "thread:thread-1"],
	text: "<!-- copilot-pr-review:finding-key:finding-1 -->\nfinding text",
	anchor: { path: "src/example.ts", line: 10 },
};

function createRecordingComments(
	calls: string[],
	overrides: Partial<ReviewBitbucketClient["comments"]> = {},
): Partial<ReviewBitbucketClient["comments"]> {
	return {
		createComment: async (text) => {
			calls.push(`create ${text.split("\n")[0]}`);
		},
		updateComment: async (comment) => {
			calls.push(`update ${comment.id}`);
		},
		deleteComment: async (comment) => {
			calls.push(`delete ${comment.id}`);
		},
		replyToComment: async (comment) => {
			calls.push(`reply ${comment.id}`);
		},
		resolveThread: async (comment) => {
			calls.push(`resolve ${comment.id}`);
		},
		...overrides,
	};
}

describe("publishReview", () => {
	it("blocks publication for an incomplete review without calling Bitbucket", async () => {
		const calls: string[] = [];
		const { logger, warnMessages } = createLoggerSpy();
		const result = await publishReview(
			createFakeBitbucketClient({
				pullRequest: {
					getPullRequest: async () => {
						calls.push("getPullRequest");
						return createPullRequest();
					},
				},
				codeInsights: {
					putReport: async () => {
						calls.push("putReport");
					},
				},
				comments: createRecordingComments(calls),
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

		assert.deepEqual(calls, []);
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
			const calls: string[] = [];
			const { logger, warnMessages } = createLoggerSpy();
			const result = await publishReview(
				createFakeBitbucketClient({
					pullRequest: { getPullRequest: async () => latest },
					codeInsights: {
						putReport: async () => {
							calls.push("putReport");
						},
					},
					comments: createRecordingComments(calls),
				}),
				baseReviewerConfig,
				createReviewContext(),
				createReviewArtifacts(baseReviewerConfig, {
					findingComments: [findingDraft],
				}),
				logger,
			);

			assert.deepEqual(result, { status: "stale", completedStages: [] });
			assert.deepEqual(calls, []);
			assert.match(warnMessages[0] ?? "", expectedWarning);
		});
	}

	it("publishes all stages from a single listing and touches only the bot's own comments", async () => {
		const context = createReviewContext();
		const artifacts = createReviewArtifacts(baseReviewerConfig, {
			findingComments: [findingDraft],
		});
		const calls: string[] = [];
		const foreignSummary = createPullRequestComment({
			id: 3,
			authorName: "alice",
			text: `Quoting the bot:\n${summaryComment.text}`,
			createdDate: 200,
		});
		const foreignFinding = createPullRequestComment({
			id: 4,
			authorName: "alice",
			text: "<!-- copilot-pr-review:finding-key:finding-1 -->\nquoted",
			createdDate: 200,
		});
		const result = await publishReview(
			createFakeBitbucketClient({
				getAuthenticatedUserName: async () => "Review-Bot",
				codeInsights: {
					putReport: async (commitId, reportKey, report) => {
						calls.push("putReport");
						assert.equal(commitId, context.headCommit);
						assert.equal(reportKey, baseReviewerConfig.report.key);
						assert.equal(report, artifacts.report);
					},
				},
				comments: createRecordingComments(calls, {
					listComments: async () => {
						calls.push("listComments");
						return [
							summaryComment,
							findingComment,
							foreignSummary,
							foreignFinding,
						];
					},
				}),
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
			"update 2",
			"create review comment",
			"delete 1",
		]);
	});

	it("fails closed without touching comments when the bot account cannot be identified", async () => {
		const calls: string[] = [];
		const result = await publishReview(
			createFakeBitbucketClient({
				getAuthenticatedUserName: async () => {
					throw new Error("no X-AUSERNAME header");
				},
				comments: createRecordingComments(calls, {
					listComments: async () => {
						calls.push("listComments");
						return [summaryComment, findingComment];
					},
				}),
			}),
			baseReviewerConfig,
			createReviewContext(),
			createReviewArtifacts(baseReviewerConfig, {
				findingComments: [findingDraft],
			}),
			createLoggerSpy().logger,
		);

		assert.deepEqual(calls, []);
		assert.deepEqual(result, {
			status: "partial",
			completedStages: ["code_insights"],
			error: { stage: "finding_comments", message: "no X-AUSERNAME header" },
		});
	});

	it("fails without later stages when the Code Insights publish fails", async () => {
		const calls: string[] = [];
		const { logger, errorMessages } = createLoggerSpy();
		const result = await publishReview(
			createFakeBitbucketClient({
				codeInsights: {
					putReport: async () => {
						throw new Error("report unavailable");
					},
				},
				comments: createRecordingComments(calls, {
					listComments: async () => {
						calls.push("listComments");
						return [];
					},
				}),
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
		assert.deepEqual(calls, []);
		assert.match(errorMessages[0] ?? "", /failed at stage code_insights/);
	});

	it("is partial and skips the summary comment when creating a finding comment fails", async () => {
		const calls: string[] = [];
		const result = await publishReview(
			createFakeBitbucketClient({
				comments: createRecordingComments(calls, {
					createComment: async (text) => {
						calls.push(`create ${text.split("\n")[0]}`);
						throw new Error("finding comment failure");
					},
				}),
			}),
			baseReviewerConfig,
			createReviewContext(),
			createReviewArtifacts(baseReviewerConfig, {
				findingComments: [findingDraft],
			}),
			createLoggerSpy().logger,
		);

		assert.deepEqual(calls, [
			"create <!-- copilot-pr-review:finding-key:finding-1 -->",
		]);
		assert.deepEqual(result, {
			status: "partial",
			completedStages: ["code_insights"],
			error: { stage: "finding_comments", message: "finding comment failure" },
		});
	});

	it("logs failed retirements without failing publication", async () => {
		const calls: string[] = [];
		const { logger, warnMessages } = createLoggerSpy();
		const result = await publishReview(
			createFakeBitbucketClient({
				comments: createRecordingComments(calls, {
					listComments: async () => [summaryComment],
					deleteComment: async (comment) => {
						calls.push(`delete ${comment.id}`);
						throw new Error("forbidden");
					},
				}),
			}),
			baseReviewerConfig,
			createReviewContext(),
			createReviewArtifacts(),
			logger,
		);

		assert.equal(result.status, "published");
		assert.deepEqual(calls, ["create review comment", "delete 1"]);
		assert.match(
			warnMessages.join("\n"),
			/Failed to delete pull request summary comment 1: forbidden/,
		);
	});

	it("re-reads comments before retrying a failed summary comment write", async () => {
		const listings: PullRequestComment[][] = [
			[summaryComment],
			[
				createPullRequestComment({
					id: 9,
					text: "<!-- copilot-pr-review -->\nconcurrent summary",
					createdDate: 300,
				}),
				summaryComment,
			],
		];
		const calls: string[] = [];
		const { logger, warnMessages } = createLoggerSpy();
		const result = await publishReview(
			createFakeBitbucketClient({
				comments: createRecordingComments(calls, {
					listComments: async () => {
						calls.push("listComments");
						return listings.shift() ?? [];
					},
					createComment: async () => {
						calls.push("create");
						throw new Error(
							`comment failure ${calls.filter((call) => call === "create").length}`,
						);
					},
				}),
			}),
			baseReviewerConfig,
			createReviewContext(),
			createReviewArtifacts(),
			logger,
		);

		assert.deepEqual(calls, [
			"listComments",
			"create",
			"listComments",
			"create",
		]);
		assert.deepEqual(result, {
			status: "partial",
			completedStages: ["code_insights", "finding_comments"],
			error: { stage: "pull_request_comment", message: "comment failure 2" },
		});
		assert.match(warnMessages[0] ?? "", /re-reading comments and retrying/);
	});

	it("does not create a second summary when the retry finds the first attempt already landed", async () => {
		const artifacts = createReviewArtifacts(baseReviewerConfig, {
			commentBody: "<!-- copilot-pr-review -->\nnew summary",
		});
		const landed = createPullRequestComment({
			id: 9,
			text: artifacts.commentBody,
			createdDate: 300,
		});
		const listings: PullRequestComment[][] = [
			[summaryComment],
			[landed, summaryComment],
		];
		const calls: string[] = [];
		const result = await publishReview(
			createFakeBitbucketClient({
				comments: createRecordingComments(calls, {
					listComments: async () => listings.shift() ?? [],
					createComment: async () => {
						calls.push("create");
						throw new Error("socket hang up");
					},
				}),
			}),
			baseReviewerConfig,
			createReviewContext(),
			artifacts,
			createLoggerSpy().logger,
		);

		assert.equal(result.status, "published");
		assert.deepEqual(calls, ["create", "delete 1"]);
	});
});

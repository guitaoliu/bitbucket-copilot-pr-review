import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import { GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";
import {
	baseReviewerConfig as baseConfig,
	createFakeBitbucketClient,
	createPullRequest,
	createReviewContext,
	createReviewOutcome,
} from "../test-support/review-fixtures.ts";
import { buildPublicationStateFields } from "./publication-state.ts";
import { runReview } from "./runner.ts";
import type {
	ReviewBitbucketClient,
	ReviewRunnerDependencies,
} from "./runner-types.ts";
import type { ReviewContext } from "./types.ts";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

function createGitStub(): GitRepository {
	return {
		getTelemetrySnapshot() {
			return { byOperation: {} };
		},
	} as GitRepository;
}

const failIfCalled = (name: string) => async (): Promise<never> => {
	throw new Error(`should not call ${name}`);
};

function readOnlyClient(pr: PullRequestInfo): ReviewBitbucketClient {
	return createFakeBitbucketClient({
		pullRequest: { getPullRequest: async () => pr },
		codeInsights: { putReport: failIfCalled("putReport") },
		comments: { upsertComment: failIfCalled("upsertComment") },
	});
}

function createDependencies(
	options: {
		client?: ReviewBitbucketClient;
		config?: ReviewerConfig;
		context?: ReviewContext;
	} & Partial<ReviewRunnerDependencies> = {},
): Partial<ReviewRunnerDependencies> {
	const { client, config, context, ...overrides } = options;
	const reviewContext = context ?? createReviewContext();
	return {
		createBitbucketClient: () => client ?? createFakeBitbucketClient(),
		prepareReviewContext: async () => ({
			config: config ?? baseConfig,
			git: createGitStub(),
			mergeBaseCommit: reviewContext.mergeBaseCommit,
		}),
		buildReviewContext: async () => reviewContext,
		runCopilotReview: async () => createReviewOutcome(),
		...overrides,
	};
}

const confirmConfig: ReviewerConfig = {
	...baseConfig,
	review: { ...baseConfig.review, confirmRerun: true },
};

describe("runReview", () => {
	it("logs the reviewable file count after filtering", async () => {
		const baseContext = createReviewContext();
		const context = {
			...baseContext,
			diffStats: { fileCount: 7, additions: 4, deletions: 1 },
			reviewableFiles: [
				...baseContext.reviewableFiles,
				{ ...baseContext.reviewableFiles[0], path: "src/second.ts" },
			],
		} as ReviewContext;
		const infoMessages: string[] = [];

		await runReview(
			baseConfig,
			{ ...logger, info: (message) => infoMessages.push(message) },
			createDependencies({ context }),
		);

		assert.ok(
			infoMessages.includes(
				"Review scope after file filtering: 2 reviewable out of 7 changed files.",
			),
		);
		assert.ok(infoMessages.includes("Completed review run"));
	});

	it("reports git telemetry from review-phase git operations", async () => {
		const repoRoot = mkdtempSync(path.join(tmpdir(), "runner-git-telemetry-"));
		try {
			execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
			writeFileSync(path.join(repoRoot, "README.md"), "hello\n");
			execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
			execFileSync(
				"git",
				[
					"-c",
					"user.name=Test",
					"-c",
					"user.email=test@example.com",
					"commit",
					"--quiet",
					"-m",
					"init",
				],
				{ cwd: repoRoot },
			);
			const git = new GitRepository(repoRoot, logger, "origin");
			await git.mergeBase("HEAD", "HEAD");
			const context = createReviewContext();

			const result = await runReview(
				baseConfig,
				logger,
				createDependencies({
					context,
					prepareReviewContext: async () => ({
						config: baseConfig,
						git,
						mergeBaseCommit: context.mergeBaseCommit,
					}),
					runCopilotReview: async (_config, _context, reviewGit) => {
						await reviewGit.readTextFileAtCommit("HEAD", "README.md");
						return createReviewOutcome();
					},
				}),
			);

			assert.deepEqual(
				Object.fromEntries(
					Object.entries(result.metrics?.gitTelemetry?.byOperation ?? {}).map(
						([operation, entry]) => [operation, entry.count],
					),
				),
				{ "merge-base": 1, "cat-file.type": 1, show: 1 },
			);
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	it("skips when the publication is already complete", async () => {
		const pr = createPullRequest();
		const context = createReviewContext(pr);
		const client = createFakeBitbucketClient({
			pullRequest: { getPullRequest: async () => pr },
			codeInsights: {
				getReport: async () => ({
					data: buildPublicationStateFields({
						revision: context.reviewRevision,
						findingCount: 0,
					}),
				}),
				putReport: failIfCalled("putReport"),
			},
			comments: {
				listComments: async () => [
					{
						id: 1,
						version: 0,
						text: "<!-- copilot-pr-review -->\n<!-- copilot-pr-review:revision:review-rev-123 -->",
					},
				],
				upsertComment: failIfCalled("upsertComment"),
			},
		});

		const result = await runReview(
			baseConfig,
			logger,
			createDependencies({
				client,
				context,
				runCopilotReview: failIfCalled("runCopilotReview"),
			}),
		);

		assert.equal(result.skipped, true);
		assert.match(result.skipReason ?? "", /fully published report/);
	});

	it("reports a stale publication when the PR head moves before publish", async () => {
		let pullRequestCalls = 0;
		const client = createFakeBitbucketClient({
			pullRequest: {
				getPullRequest: async () => {
					pullRequestCalls += 1;
					return createPullRequest(
						pullRequestCalls === 1 ? "head-123" : "head-456",
					);
				},
			},
			codeInsights: { putReport: failIfCalled("putReport") },
			comments: { upsertComment: failIfCalled("upsertComment") },
		});

		const result = await runReview(
			baseConfig,
			logger,
			createDependencies({ client }),
		);

		assert.equal(result.skipped, false);
		assert.equal(result.published, false);
		assert.equal(result.publicationStatus, "stale");
		assert.equal(result.review.stale, true);
	});

	it("returns partial publication metadata when the PR comment update fails", async () => {
		let commentAttempts = 0;
		const client = createFakeBitbucketClient({
			comments: {
				upsertComment: async () => {
					commentAttempts += 1;
					throw new Error(`comment failure ${commentAttempts}`);
				},
			},
		});

		const result = await runReview(
			baseConfig,
			logger,
			createDependencies({ client }),
		);

		assert.equal(commentAttempts, 2);
		assert.equal(result.published, false);
		assert.equal(result.review.stale, false);
		assert.equal(result.publicationStatus, "partial");
		assert.deepEqual(result.publication, {
			status: "partial",
			attempted: true,
			codeInsightsPublished: true,
			findingCommentsUpdated: true,
			pullRequestCommentUpdated: false,
			error: { stage: "pull_request_comment", message: "comment failure 2" },
		});
	});

	for (const [label, pr, expectedReason] of [
		["closed", { ...createPullRequest(), state: "MERGED" }, /is MERGED/],
		[
			"renovate",
			{
				...createPullRequest(),
				source: {
					...createPullRequest().source,
					displayId: "renovate/typescript-5.x",
				},
			},
			/matches skip prefix renovate\//,
		],
		["draft", { ...createPullRequest(), draft: true }, /is a draft/],
	] as const) {
		it(`skips ${label} pull requests before building review context`, async () => {
			let buildContextCalled = false;
			const result = await runReview(
				baseConfig,
				logger,
				createDependencies({
					client: readOnlyClient(pr),
					buildReviewContext: async () => {
						buildContextCalled = true;
						return createReviewContext(pr);
					},
				}),
			);

			assert.equal(buildContextCalled, false);
			assert.equal(result.skipped, true);
			assert.match(result.skipReason ?? "", expectedReason);
		});
	}

	it("uses trusted repo config before applying branch-prefix skips", async () => {
		const pr = {
			...createPullRequest(),
			source: {
				...createPullRequest().source,
				displayId: "renovate/typescript-5.x",
			},
		};
		let copilotCalled = false;

		const result = await runReview(
			baseConfig,
			logger,
			createDependencies({
				client: createFakeBitbucketClient({
					pullRequest: { getPullRequest: async () => pr },
				}),
				context: createReviewContext(pr),
				config: {
					...baseConfig,
					review: { ...baseConfig.review, skipBranchPrefixes: [] },
				},
				runCopilotReview: async () => {
					copilotCalled = true;
					return createReviewOutcome();
				},
			}),
		);

		assert.equal(copilotCalled, true);
		assert.equal(result.skipped, false);
	});

	it("uses repo-configured branch prefixes when deciding skips", async () => {
		const pr = {
			...createPullRequest(),
			source: {
				...createPullRequest().source,
				displayId: "deps/typescript-5.x",
			},
		};

		const result = await runReview(
			baseConfig,
			logger,
			createDependencies({
				client: readOnlyClient(pr),
				context: createReviewContext(pr),
				config: {
					...baseConfig,
					review: { ...baseConfig.review, skipBranchPrefixes: ["deps/"] },
				},
				buildReviewContext: failIfCalled("buildReviewContext"),
				runCopilotReview: failIfCalled("runCopilotReview"),
			}),
		);

		assert.equal(result.skipped, true);
		assert.match(result.skipReason ?? "", /matches skip prefix deps\//);
	});

	it("skips rerun when confirm-rerun is enabled and the user declines", async () => {
		const context = createReviewContext();
		const sequence: string[] = [];
		const client = createFakeBitbucketClient({
			codeInsights: {
				getReport: async () => ({
					data: buildPublicationStateFields({
						revision: context.reviewRevision,
						findingCount: 1,
					}),
				}),
				putReport: failIfCalled("putReport"),
			},
			comments: { upsertComment: failIfCalled("upsertComment") },
		});

		const result = await runReview(
			confirmConfig,
			{ ...logger, warn: (message) => sequence.push(`warn:${message}`) },
			createDependencies({
				client,
				context,
				config: confirmConfig,
				runCopilotReview: failIfCalled("runCopilotReview"),
				confirmRerun: async ({ message }) => {
					sequence.push(`confirm:${message}`);
					return false;
				},
			}),
		);

		assert.equal(result.skipped, true);
		assert.match(result.skipReason ?? "", /manual confirmation declined/);
		assert.equal(sequence.length, 2);
		assert.match(
			sequence[0] ?? "",
			/^warn:Found an existing but unusable report copilot-review for revision review-rev-123; rerunning review/,
		);
		assert.match(
			sequence[1] ?? "",
			/^confirm:Existing published artifacts for PR revision review-rev-123 look unusable\./,
		);
	});

	it("reruns without prompting when no report exists for the current head", async () => {
		const context = createReviewContext();
		let confirmCalled = false;
		let copilotCalled = false;
		const warnings: string[] = [];
		const client = createFakeBitbucketClient({
			codeInsights: {
				getReport: async (commitId) => {
					assert.equal(commitId, context.headCommit);
					return undefined;
				},
			},
			comments: {
				listComments: async () => [
					{
						id: 1,
						version: 0,
						text: "<!-- copilot-pr-review -->\n<!-- copilot-pr-review:revision:older-revision -->",
					},
				],
			},
		});

		const result = await runReview(
			confirmConfig,
			{ ...logger, warn: (message) => warnings.push(message) },
			createDependencies({
				client,
				context,
				config: confirmConfig,
				runCopilotReview: async () => {
					copilotCalled = true;
					return createReviewOutcome();
				},
				confirmRerun: async () => {
					confirmCalled = true;
					return false;
				},
			}),
		);

		assert.equal(confirmCalled, false);
		assert.equal(copilotCalled, true);
		assert.equal(result.skipped, false);
		assert.deepEqual(warnings, []);
	});
});

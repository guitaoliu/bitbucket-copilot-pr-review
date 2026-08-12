import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
	PullRequestInfo,
	RawBitbucketCodeInsightsReport,
} from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import {
	buildPullRequestCommentMetadataMarkers,
	buildReviewMetadataFields,
} from "./publication-state.ts";
import { getReviewRevisionSchema } from "./revision.ts";
import type { ReviewBitbucketClient } from "./runner-types.ts";
import {
	buildReviewReusePlan,
	getExistingPublicationStatus,
} from "./skip-policy.ts";
import type { ReviewContext } from "./types.ts";

const baseConfig = {
	report: {
		key: "copilot-review",
		commentTag: "copilot-pr-review",
	},
	review: {
		forceReview: false,
	},
} as ReviewerConfig;

function createPullRequest(commit = "head-123"): PullRequestInfo {
	return {
		id: 123,
		version: 1,
		title: "Test PR",
		description: "",
		source: {
			repositoryId: 1,
			projectKey: "PROJ",
			repoSlug: "repo",
			refId: "refs/heads/feature",
			displayId: "feature",
			latestCommit: commit,
		},
		target: {
			repositoryId: 1,
			projectKey: "PROJ",
			repoSlug: "repo",
			refId: "refs/heads/main",
			displayId: "main",
			latestCommit: "base-123",
		},
	};
}

function createContext(): ReviewContext {
	const pr = createPullRequest();
	return {
		repoRoot: "/tmp/repo",
		pr,
		headCommit: pr.source.latestCommit,
		baseCommit: pr.target.latestCommit,
		mergeBaseCommit: pr.target.latestCommit,
		reviewRevision: "review-rev-123",
		rawDiff: "",
		diffStats: { fileCount: 0, additions: 0, deletions: 0 },
		reviewableFiles: [],
	};
}

function createReport(
	context: ReviewContext,
	options: { reviewedCommit?: string; schema?: string } = {},
): RawBitbucketCodeInsightsReport {
	return {
		data: [
			{ title: "Findings", type: "NUMBER", value: 1 },
			...buildReviewMetadataFields({
				revision: context.reviewRevision,
				reviewedCommit: options.reviewedCommit ?? context.headCommit,
				...(options.schema ? { schema: options.schema } : {}),
			}),
		],
	};
}

function createTaggedComment(
	options: {
		revision?: string;
		reviewedCommit?: string;
		publishedCommit?: string;
		schema?: string;
	} = {},
): { text: string } {
	return {
		text: [
			"<!-- copilot-pr-review -->",
			...buildPullRequestCommentMetadataMarkers({
				tag: "copilot-pr-review",
				revision: options.revision ?? "review-rev-123",
				reviewedCommit: options.reviewedCommit ?? "head-123",
				publishedCommit: options.publishedCommit ?? "head-123",
				...(options.schema ? { schema: options.schema } : {}),
			}),
		].join("\n"),
	};
}

function createClient(
	report: RawBitbucketCodeInsightsReport | undefined,
	comment: { text: string } | undefined,
): ReviewBitbucketClient {
	return {
		async getPullRequest() {
			return createPullRequest();
		},
		async getCodeInsightsReport() {
			return report;
		},
		async findPullRequestCommentByTag() {
			return comment;
		},
		async publishCodeInsights() {},
		async reconcilePullRequestFindingComments() {},
		async upsertPullRequestComment() {},
	};
}

describe("review reuse", () => {
	it("skips a complete publication on the current head", async () => {
		const context = createContext();
		const status = await getExistingPublicationStatus(
			createClient(createReport(context), createTaggedComment()),
			baseConfig,
			context,
		);

		assert.equal(status.existingPublicationComplete, true);
		assert.equal(
			buildReviewReusePlan(baseConfig, context, status).action,
			"skip",
		);
	});

	it("reruns when the publication is incomplete", async () => {
		const context = createContext();
		const status = await getExistingPublicationStatus(
			createClient(createReport(context), undefined),
			baseConfig,
			context,
		);

		const plan = buildReviewReusePlan(baseConfig, context, status);
		assert.equal(plan.action, "review");
		assert.match(plan.repairWarning ?? "", /rerunning review/);
	});

	it("reruns publications from an older schema", async () => {
		const context = createContext();
		const status = await getExistingPublicationStatus(
			createClient(
				createReport(context, { schema: "2" }),
				createTaggedComment({ schema: "2" }),
			),
			baseConfig,
			context,
		);

		assert.equal(status.existingPublicationComplete, false);
		assert.match(status.unusableReasons.join("; "), /report schema 2/);
		assert.equal(getReviewRevisionSchema(), "3");
	});

	it("reruns automatically when the stored review belongs to another head", () => {
		const context = createContext();
		const plan = buildReviewReusePlan(baseConfig, context, {
			existingReport: createReport(context, { reviewedCommit: "head-old" }),
			existingComment: createTaggedComment({
				reviewedCommit: "head-old",
				publishedCommit: "head-old",
			}),
			reportCommit: "head-old",
			reportRevision: context.reviewRevision,
			reportReviewedCommit: "head-old",
			reportSchema: getReviewRevisionSchema(),
			commentRevision: context.reviewRevision,
			commentReviewedCommit: "head-old",
			commentPublishedCommit: "head-old",
			existingPublicationComplete: false,
			unusableReasons: ["head changed"],
		});

		assert.equal(plan.action, "review");
		assert.equal(plan.confirmMessage, undefined);
	});
});

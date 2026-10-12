import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
	PullRequestComment,
	RawBitbucketCodeInsightsReport,
} from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import {
	baseReviewerConfig,
	createFakeBitbucketClient,
	createPullRequestComment,
	createReviewContext,
} from "../test-support/review-fixtures.ts";
import { formatCommentTagMarker, formatRevisionMarker } from "./markers.ts";
import { buildPublicationStateFields } from "./publication-state.ts";
import type { ReviewBitbucketClient } from "./runner-types.ts";
import {
	buildReviewReusePlan,
	getExistingPublicationStatus,
} from "./skip-policy.ts";

const context = createReviewContext();
const tag = baseReviewerConfig.report.commentTag;

function createReport(
	revision = context.reviewRevision,
): RawBitbucketCodeInsightsReport {
	return {
		data: buildPublicationStateFields({ revision, findingCount: 1 }),
	};
}

function createSummaryComment(
	revision = context.reviewRevision,
	authorName?: string,
): PullRequestComment {
	return createPullRequestComment({
		id: 1,
		text: [
			formatCommentTagMarker(tag),
			formatRevisionMarker(tag, revision),
		].join("\n"),
		...(authorName ? { authorName } : {}),
	});
}

function createClient(
	report: RawBitbucketCodeInsightsReport | undefined,
	comment: PullRequestComment | undefined,
): ReviewBitbucketClient {
	const findingComment = createPullRequestComment({
		id: 2,
		text: `<!-- ${tag}:finding-thread:thread-1 -->`,
	});
	return createFakeBitbucketClient({
		codeInsights: { getReport: async () => report },
		comments: {
			listComments: async () =>
				comment ? [findingComment, comment] : [findingComment],
		},
	});
}

async function planFor(
	report: RawBitbucketCodeInsightsReport | undefined,
	comment: PullRequestComment | undefined,
	config: ReviewerConfig = baseReviewerConfig,
) {
	const status = await getExistingPublicationStatus(
		createClient(report, comment),
		config,
		context,
	);
	return buildReviewReusePlan(config, context, status);
}

const confirmConfig: ReviewerConfig = {
	...baseReviewerConfig,
	review: { ...baseReviewerConfig.review, confirmRerun: true },
};

describe("review reuse", () => {
	it("skips when the report and summary comment carry the current revision", async () => {
		const plan = await planFor(createReport(), createSummaryComment());

		assert.equal(plan.action, "skip");
	});

	it("reviews without a repair warning when no report exists yet", async () => {
		const plan = await planFor(undefined, createSummaryComment());

		assert.deepEqual(plan, { action: "review" });
	});

	it("reviews again when forced even if the publication is complete", async () => {
		const plan = await planFor(createReport(), createSummaryComment(), {
			...baseReviewerConfig,
			review: { ...baseReviewerConfig.review, forceReview: true },
		});

		assert.deepEqual(plan, { action: "review" });
	});

	it("repairs a publication whose summary comment is missing", async () => {
		const plan = await planFor(createReport(), undefined);

		assert.equal(plan.action, "review");
		assert.match(
			plan.action === "review" ? (plan.repairWarning ?? "") : "",
			/comment revision missing != review-rev-123/,
		);
	});

	it("ignores a summary with the current revision that another user posted", async () => {
		const plan = await planFor(
			createReport(),
			createSummaryComment(context.reviewRevision, "alice"),
		);

		assert.equal(plan.action, "review");
		assert.match(
			plan.action === "review" ? (plan.repairWarning ?? "") : "",
			/comment revision missing != review-rev-123/,
		);
	});

	it("repairs a report without a valid findings count", async () => {
		const plan = await planFor(
			{
				data: [
					{
						title: "Review revision",
						type: "TEXT",
						value: context.reviewRevision,
					},
				],
			},
			createSummaryComment(),
		);

		assert.equal(plan.action, "review");
		assert.match(
			plan.action === "review" ? (plan.repairWarning ?? "") : "",
			/report findings field is missing or invalid/,
		);
	});

	it("asks for confirmation only when confirm-rerun is enabled and the report revision is current", async () => {
		const unconfirmed = await planFor(createReport(), undefined);
		const confirmed = await planFor(createReport(), undefined, confirmConfig);
		const outdated = await planFor(
			createReport("older-rev"),
			createSummaryComment("older-rev"),
			confirmConfig,
		);

		assert.equal(
			unconfirmed.action === "review" && unconfirmed.confirmMessage,
			undefined,
		);
		assert.match(
			confirmed.action === "review" ? (confirmed.confirmMessage ?? "") : "",
			/Existing published artifacts for PR revision review-rev-123 look unusable/,
		);
		assert.equal(
			outdated.action === "review" && outdated.confirmMessage,
			undefined,
		);
	});
});

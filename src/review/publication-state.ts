import type {
	InsightReportDataField,
	InsightReportPayload,
} from "../bitbucket/types.ts";
import { getReviewRevisionSchema } from "./revision.ts";

const REVIEW_REVISION_FIELD_TITLE = "Review revision";
const REVIEW_SCHEMA_FIELD_TITLE = "Review schema";
const REVIEWED_COMMIT_FIELD_TITLE = "Reviewed commit";

const COMMENT_METADATA_KEYS = [
	"schema",
	"revision",
	"reviewed-commit",
	"published-commit",
] as const;

function escapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getReportFieldValue(
	report: Pick<InsightReportPayload, "data"> | undefined,
	title: string,
): InsightReportDataField["value"] | undefined {
	return report?.data?.find((entry) => entry.title === title)?.value;
}

function getTextReportField(
	report: Pick<InsightReportPayload, "data"> | undefined,
	title: string,
): string | undefined {
	const value = getReportFieldValue(report, title);
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function buildPullRequestCommentTagMarker(tag: string): string {
	return `<!-- ${tag} -->`;
}

export function buildPullRequestCommentMetadataMarkers(options: {
	tag: string;
	revision: string;
	reviewedCommit: string;
	publishedCommit: string;
	schema?: string;
}): string[] {
	const schema = options.schema ?? getReviewRevisionSchema();
	return [
		`<!-- ${options.tag}:schema:${schema} -->`,
		`<!-- ${options.tag}:revision:${options.revision} -->`,
		`<!-- ${options.tag}:reviewed-commit:${options.reviewedCommit} -->`,
		`<!-- ${options.tag}:published-commit:${options.publishedCommit} -->`,
	];
}

export function parsePullRequestCommentMetadata(
	tag: string,
	text: string,
):
	| {
			schema?: string;
			revision?: string;
			reviewedCommit?: string;
			publishedCommit?: string;
	  }
	| undefined {
	if (!text.includes(buildPullRequestCommentTagMarker(tag))) {
		return undefined;
	}

	const metadata: {
		schema?: string;
		revision?: string;
		reviewedCommit?: string;
		publishedCommit?: string;
	} = {};

	for (const key of COMMENT_METADATA_KEYS) {
		const match = new RegExp(
			`<!--\\s*${escapeRegexLiteral(tag)}:${escapeRegexLiteral(key)}:([^>]+?)\\s*-->`,
		).exec(text);
		const value = match?.[1]?.trim();
		if (!value) {
			continue;
		}

		switch (key) {
			case "schema":
				metadata.schema = value;
				break;
			case "revision":
				metadata.revision = value;
				break;
			case "reviewed-commit":
				metadata.reviewedCommit = value;
				break;
			case "published-commit":
				metadata.publishedCommit = value;
				break;
		}
	}

	return metadata;
}

export function getInsightReportFindingCount(
	report: Pick<InsightReportPayload, "data"> | undefined,
): number | undefined {
	const field = getReportFieldValue(report, "Findings");
	if (typeof field === "number" && Number.isFinite(field)) {
		return field;
	}

	if (typeof field === "string" && /^\d+$/.test(field.trim())) {
		return Number.parseInt(field.trim(), 10);
	}

	return undefined;
}

export function getInsightReportReviewRevision(
	report: Pick<InsightReportPayload, "data"> | undefined,
): string | undefined {
	return getTextReportField(report, REVIEW_REVISION_FIELD_TITLE);
}

export function getInsightReportReviewSchema(
	report: Pick<InsightReportPayload, "data"> | undefined,
): string | undefined {
	return getTextReportField(report, REVIEW_SCHEMA_FIELD_TITLE);
}

export function getInsightReportReviewedCommit(
	report: Pick<InsightReportPayload, "data"> | undefined,
): string | undefined {
	return getTextReportField(report, REVIEWED_COMMIT_FIELD_TITLE);
}

export function buildReviewMetadataFields(options: {
	revision: string;
	reviewedCommit: string;
	schema?: string;
}): InsightReportDataField[] {
	return [
		{
			title: REVIEW_REVISION_FIELD_TITLE,
			type: "TEXT",
			value: options.revision,
		},
		{
			title: REVIEW_SCHEMA_FIELD_TITLE,
			type: "TEXT",
			value: options.schema ?? getReviewRevisionSchema(),
		},
		{
			title: REVIEWED_COMMIT_FIELD_TITLE,
			type: "TEXT",
			value: options.reviewedCommit,
		},
	];
}

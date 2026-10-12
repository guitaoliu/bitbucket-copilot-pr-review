import type { InsightReportPayload } from "../bitbucket/types.ts";
import type {
	ReviewOutcome,
	ReviewPublicationError,
	ReviewPublicationStatus,
} from "./types.ts";

type ReviewRunOutputReview = Omit<
	ReviewOutcome,
	"gitTelemetry" | "toolTelemetry" | "copilotUsage"
> & { stale: boolean };

export interface ReviewPublication {
	status: ReviewPublicationStatus;
	attempted: boolean;
	codeInsightsPublished: boolean;
	findingCommentsUpdated: boolean;
	pullRequestCommentUpdated: boolean;
	error?: ReviewPublicationError;
}

export interface ReviewRunOutput {
	context: {
		toolVersion: string;
		prId: number;
		title: string;
		sourceBranch: string;
		targetBranch: string;
		headCommit: string;
		mergeBaseCommit: string;
		reviewRevision?: string;
		reviewableFiles: number;
	};
	metrics?: {
		gitTelemetry?: ReviewOutcome["gitTelemetry"];
		toolTelemetry?: ReviewOutcome["toolTelemetry"];
		copilotUsage?: ReviewOutcome["copilotUsage"];
	};
	review: ReviewRunOutputReview;
	report: InsightReportPayload;
	commentBody?: string;
	published: boolean;
	publication?: ReviewPublication;
	publicationStatus?: ReviewPublicationStatus;
	skipped: boolean;
	skipReason?: string;
}

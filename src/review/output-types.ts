import type { InsightReportPayload } from "../bitbucket/types.ts";
import type {
	ReviewOutcome,
	ReviewPublication,
	ReviewPublicationStatus,
} from "./types.ts";

type ReviewRunOutputReview = Omit<
	ReviewOutcome,
	"gitTelemetry" | "toolTelemetry" | "copilotUsage"
>;

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
		reviewedFiles: number;
		skippedFiles: number;
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

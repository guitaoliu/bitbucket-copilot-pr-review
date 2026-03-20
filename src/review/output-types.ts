import type {
	InsightAnnotationPayload,
	InsightReportPayload,
} from "../bitbucket/types.ts";
import type {
	ReviewOutcome,
	ReviewPublication,
	ReviewPublicationStatus,
} from "./types.ts";

type ReviewRunOutputReview = Omit<
	ReviewOutcome,
	"gitTelemetry" | "toolTelemetry"
>;

export interface ReviewRunOutput {
	context: {
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
	};
	review: ReviewRunOutputReview;
	report: InsightReportPayload;
	annotations: InsightAnnotationPayload[];
	commentBody?: string;
	published: boolean;
	publication?: ReviewPublication;
	publicationStatus?: ReviewPublicationStatus;
	skipped: boolean;
	skipReason?: string;
}

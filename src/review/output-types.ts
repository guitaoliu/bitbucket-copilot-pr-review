import type {
	InsightAnnotationPayload,
	InsightReportPayload,
} from "../bitbucket/types.ts";
import type { ReviewOutcome } from "./types.ts";

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
	review: ReviewOutcome;
	report: InsightReportPayload;
	annotations: InsightAnnotationPayload[];
	commentBody?: string;
	published: boolean;
	skipped: boolean;
	skipReason?: string;
}

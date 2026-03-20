import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ChangedFile, DiffStats, SkippedFile } from "../git/types.ts";

export type Severity = "LOW" | "MEDIUM" | "HIGH";

export type AnnotationType = "BUG" | "CODE_SMELL" | "VULNERABILITY";

export type Confidence = "low" | "medium" | "high";

export interface RepoAgentsInstructions {
	path: string;
	appliesTo: string[];
	content: string;
}

export interface ReviewToolTelemetryCounter {
	requested: number;
	allowed: number;
	denied: number;
	completed: number;
	resultCounts: Record<string, number>;
	totalDurationMs: number;
	maxDurationMs: number;
	totalInputChars: number;
	totalOutputChars: number;
	truncatedResponses: number;
	filteredResultCount: number;
}

export interface ReviewToolTelemetry {
	totalRequested: number;
	totalAllowed: number;
	totalDenied: number;
	totalCompleted: number;
	totalDurationMs: number;
	sessionDurationMs: number;
	errorCount: number;
	assistantMessageChars: number;
	byTool: Record<string, ReviewToolTelemetryCounter>;
}

export interface ReviewGitOperationTelemetry {
	count: number;
	durationMsTotal: number;
}

export interface ReviewGitTelemetry {
	byOperation: Record<string, ReviewGitOperationTelemetry>;
}

export type ReviewPublicationStatus =
	| "dry_run"
	| "stale"
	| "published"
	| "partial"
	| "failed";

export type ReviewPublicationFailureStage =
	| "code_insights"
	| "pull_request_comment";

export interface ReviewPublicationError {
	stage: ReviewPublicationFailureStage;
	message: string;
}

export interface ReviewPublication {
	status: ReviewPublicationStatus;
	attempted: boolean;
	codeInsightsPublished: boolean;
	pullRequestCommentUpdated: boolean;
	error?: ReviewPublicationError;
}

export interface ReviewContext {
	repoRoot: string;
	pr: PullRequestInfo;
	headCommit: string;
	baseCommit: string;
	mergeBaseCommit: string;
	reviewRevision: string;
	rawDiff: string;
	diffStats: DiffStats;
	reviewedFiles: ChangedFile[];
	skippedFiles: SkippedFile[];
	repoAgentsInstructions?: RepoAgentsInstructions[];
	ciSummary?: string;
}

export interface FindingDraft {
	path: string;
	line: number;
	severity: Severity;
	type: AnnotationType;
	confidence: Confidence;
	title: string;
	details: string;
	category?: string;
}

export interface ReviewFinding extends FindingDraft {
	externalId: string;
}

export interface FileChangeSummary {
	path: string;
	summary: string;
}

export interface StoredReviewFinding {
	path: string;
	line?: number;
	severity: Severity;
	type: AnnotationType;
	confidence?: Confidence;
	title: string;
	details?: string;
	category?: string;
	externalId?: string;
}

export interface ReviewSummaryDrafts {
	prSummary?: string;
	fileSummaries: FileChangeSummary[];
}

export interface ReviewOutcome {
	summary: string;
	findings: ReviewFinding[];
	assistantMessage?: string;
	prSummary?: string;
	fileSummaries?: FileChangeSummary[];
	gitTelemetry?: ReviewGitTelemetry;
	toolTelemetry?: ReviewToolTelemetry;
	stale: boolean;
}

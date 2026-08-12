import type { CopilotSession } from "@github/copilot-sdk";
import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ChangedFile, DiffStats } from "../git/types.ts";

type CopilotModelMetrics = Awaited<
	ReturnType<CopilotSession["rpc"]["usage"]["getMetrics"]>
>["modelMetrics"];

type Severity = "LOW" | "MEDIUM" | "HIGH";

export type AnnotationType = "BUG" | "CODE_SMELL" | "VULNERABILITY";

export type Confidence = "low" | "medium" | "high";

export interface ReviewToolTelemetryCounter {
	requested: number;
	allowed: number;
	denied: number;
	completed: number;
	resultCounts: Record<string, number>;
	totalDurationMs: number;
}

export interface ReviewToolTelemetry {
	totalRequested: number;
	totalAllowed: number;
	totalDenied: number;
	totalCompleted: number;
	totalDurationMs: number;
	sessionDurationMs: number;
	errorCount: number;
	byTool: Record<string, ReviewToolTelemetryCounter>;
}

interface ReviewGitOperationTelemetry {
	count: number;
	durationMsTotal: number;
}

export interface ReviewGitTelemetry {
	byOperation: Record<string, ReviewGitOperationTelemetry>;
}

export interface ReviewCopilotUsage {
	aiCredits?: number;
	usageValueUsd?: number;
	modelMetrics: CopilotModelMetrics;
}

export type ReviewPublicationStatus =
	| "dry_run"
	| "stale"
	| "published"
	| "partial"
	| "failed";

type ReviewPublicationFailureStage =
	| "code_insights"
	| "finding_comments"
	| "pull_request_comment";

export interface ReviewPublicationError {
	stage: ReviewPublicationFailureStage;
	message: string;
}

export interface ReviewPublication {
	status: ReviewPublicationStatus;
	attempted: boolean;
	codeInsightsPublished: boolean;
	findingCommentsUpdated: boolean;
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
	reviewableFiles: ChangedFile[];
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
	threadKey: string;
}

export interface ChangeAreaSummary {
	title: string;
	paths: string[];
	summary: string;
}

type ReviewCompletionOutcome = "clean" | "findings_recorded";

export interface ReviewSummaryDrafts {
	prSummary?: string;
	reviewOutcome?: ReviewCompletionOutcome;
	changeAreas?: ChangeAreaSummary[];
}

export interface ReviewOutcome {
	summary: string;
	findings: ReviewFinding[];
	assistantMessage?: string;
	prSummary?: string;
	changeAreas?: ChangeAreaSummary[];
	gitTelemetry?: ReviewGitTelemetry;
	toolTelemetry?: ReviewToolTelemetry;
	copilotUsage?: ReviewCopilotUsage;
	stale: boolean;
}

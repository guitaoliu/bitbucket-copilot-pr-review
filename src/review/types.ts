import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ChangedFile, DiffStats, SkippedFile } from "../git/types.ts";

export type Severity = "LOW" | "MEDIUM" | "HIGH";

export type AnnotationType = "BUG" | "CODE_SMELL" | "VULNERABILITY";

export type Confidence = "low" | "medium" | "high";

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
	rootAgentsInstructions?: string;
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
	stale: boolean;
}

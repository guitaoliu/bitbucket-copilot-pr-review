import type {
	BitbucketAuthConfig,
	ReviewerConfigRepoOverrides,
} from "../config/types.ts";
import type { ReviewRunOutput } from "../review/output-types.ts";
import type { LogLevel } from "../shared/types.ts";

export interface BatchReviewBitbucketConfig {
	baseUrl: string;
	projectKey: string;
	repoSlug: string;
	auth: BitbucketAuthConfig;
	tls: {
		caCertPath?: string | undefined;
		insecureSkipVerify: boolean;
	};
}

export interface BatchReviewConfig {
	repoId: string;
	repositoryUrl: string;
	tempRoot: string;
	maxParallel: number;
	keepWorkdirs: boolean;
	gitRemoteName: string;
	logLevel: LogLevel;
	bitbucket: BatchReviewBitbucketConfig;
	review: {
		dryRun: boolean;
		forceReview: boolean;
		confirmRerun: boolean;
		skipBranchPrefixes: string[];
	};
	internal?: {
		envRepoOverrides: ReviewerConfigRepoOverrides;
	};
}

export interface BatchMirrorMetrics {
	path: string;
	action: "created" | "refreshed";
	durationMs: number;
	lockWaitMs: number;
}

export interface BatchReviewWorkspaceMetrics {
	provisionDurationMs: number;
	cleanupDurationMs?: number | undefined;
	retained: boolean;
}

export interface BatchWorkspaceLifecycleMetrics {
	tempRoot: string;
	runRoot?: string | undefined;
	provisioned: number;
	cleaned: number;
	retained: number;
	provisionDurationMsTotal: number;
	workspaceCleanupDurationMsTotal: number;
	runRootCleanupDurationMs: number;
	runRootRemoved: boolean;
}

export interface BatchReviewMetrics {
	mirror?: BatchMirrorMetrics | undefined;
	workspaces: BatchWorkspaceLifecycleMetrics;
}

export type BatchReviewResultStatus = "reviewed" | "skipped" | "failed";

export interface BatchReviewResult {
	prId: number;
	title: string;
	status: BatchReviewResultStatus;
	durationMs: number;
	workdir?: string | undefined;
	workspace?: BatchReviewWorkspaceMetrics | undefined;
	output?: ReviewRunOutput | undefined;
	skipReason?: string | undefined;
	error?: string | undefined;
}

export interface BatchReviewOutput {
	repository: {
		repoId: string;
		projectKey: string;
		repoSlug: string;
	};
	totalOpenPullRequests: number;
	reviewed: number;
	skipped: number;
	failed: number;
	metrics: BatchReviewMetrics;
	results: BatchReviewResult[];
}

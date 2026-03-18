import type { Confidence } from "../review/types.ts";
import type { LogLevel } from "../shared/types.ts";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type PullRequestCommentStrategy = "update" | "recreate";

export interface ReviewerConfigRepoOverrides {
	copilot: {
		model?: string | undefined;
		reasoningEffort?: ReasoningEffort | undefined;
		timeoutMs?: number | undefined;
	};
	report: {
		title?: string | undefined;
		commentStrategy?: PullRequestCommentStrategy | undefined;
	};
	review: {
		maxFiles?: number | undefined;
		maxFindings?: number | undefined;
		minConfidence?: Confidence | undefined;
		maxPatchChars?: number | undefined;
		defaultFileSliceLines?: number | undefined;
		maxFileSliceLines?: number | undefined;
		ignorePaths?: string[] | undefined;
		skipBranchPrefixes?: string[] | undefined;
	};
}

export interface ReviewerConfigInternal {
	envRepoOverrides: ReviewerConfigRepoOverrides;
	trustedRepoConfig?:
		| {
				path: string;
				commit: string;
		  }
		| undefined;
}

export interface BearerAuthConfig {
	type: "bearer";
	token: string;
}

export interface BasicAuthConfig {
	type: "basic";
	username: string;
	password: string;
}

export type BitbucketAuthConfig = BearerAuthConfig | BasicAuthConfig;

export interface ReviewerConfig {
	repoRoot: string;
	gitRemoteName: string;
	logLevel: LogLevel;
	bitbucket: {
		baseUrl: string;
		projectKey: string;
		repoSlug: string;
		prId: number;
		auth: BitbucketAuthConfig;
		tls: {
			caCertPath?: string | undefined;
			insecureSkipVerify: boolean;
		};
	};
	copilot: {
		model: string;
		reasoningEffort: ReasoningEffort;
		timeoutMs: number;
	};
	report: {
		key: string;
		title: string;
		reporter: string;
		link?: string | undefined;
		commentTag: string;
		commentStrategy: PullRequestCommentStrategy;
	};
	review: {
		dryRun: boolean;
		forceReview: boolean;
		confirmRerun: boolean;
		maxFiles: number;
		maxFindings: number;
		minConfidence: Confidence;
		maxPatchChars: number;
		defaultFileSliceLines: number;
		maxFileSliceLines: number;
		ignorePaths: string[];
		skipBranchPrefixes: string[];
	};
	ciSummaryPath?: string | undefined;
	internal?: ReviewerConfigInternal | undefined;
}

export type { Confidence, LogLevel };

export interface BitbucketRepositoryIdentity {
	baseUrl: string;
	projectKey: string;
	repoSlug: string;
}

export interface BitbucketPullRequestIdentity
	extends BitbucketRepositoryIdentity {
	prId: number;
}

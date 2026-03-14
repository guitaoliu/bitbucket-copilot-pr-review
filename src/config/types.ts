import type { Confidence } from "../review/types.ts";
import type { LogLevel } from "../shared/types.ts";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type PullRequestCommentStrategy = "update" | "recreate";

export interface ReviewerConfigExplicitEnvOverrides {
	copilot: {
		model: boolean;
		reasoningEffort: boolean;
		timeoutMs: boolean;
	};
	report: {
		title: boolean;
		commentStrategy: boolean;
	};
	review: {
		maxFiles: boolean;
		maxFindings: boolean;
		minConfidence: boolean;
		maxPatchChars: boolean;
		defaultFileSliceLines: boolean;
		maxFileSliceLines: boolean;
		ignorePaths: boolean;
	};
}

export interface ReviewerConfigInternal {
	explicitEnvOverrides: ReviewerConfigExplicitEnvOverrides;
	trustedRepoConfig?: {
		path: string;
		commit: string;
	};
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
			caCertPath?: string;
			insecureSkipVerify: boolean;
		};
	};
	copilot: {
		model: string;
		githubToken?: string;
		reasoningEffort: ReasoningEffort;
		timeoutMs: number;
	};
	report: {
		key: string;
		title: string;
		reporter: string;
		link?: string;
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
	};
	ciSummaryPath?: string;
	internal?: ReviewerConfigInternal;
}

export type { LogLevel, Confidence };

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
		maxFindings?: number | undefined;
		minConfidence?: Confidence | undefined;
		maxPatchChars?: number | undefined;
		defaultFileSliceLines?: number | undefined;
		maxFileSliceLines?: number | undefined;
		ignorePaths?: string[] | undefined;
		skipBranchPrefixes?: string[] | undefined;
	};
}

interface ReviewerConfigInternal {
	envRepoOverrides: ReviewerConfigRepoOverrides;
	trustedRepoConfig?:
		| {
				path: string;
				commit: string;
		  }
		| undefined;
}

interface BearerAuthConfig {
	type: "bearer";
	token: string;
}

interface BasicAuthConfig {
	type: "basic";
	username: string;
	password: string;
}

export type BitbucketAuthConfig = BearerAuthConfig | BasicAuthConfig;

export interface ReviewerConfig {
	repoRoot: string;
	gitRemoteName: string;
	logLevel: LogLevel;
	githubHost?: string | undefined;
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

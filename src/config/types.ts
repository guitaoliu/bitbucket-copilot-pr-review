import type { SessionConfig } from "@github/copilot-sdk";
import type { Confidence } from "../review/types.ts";
import type { LogLevel } from "../shared/types.ts";
import type { RepoReviewConfig } from "./repo-config.ts";

export const REASONING_EFFORT_VALUES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly NonNullable<SessionConfig["reasoningEffort"]>[];

type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export const REPORT_COMMENT_STRATEGY_VALUES = ["update", "recreate"] as const;

export type PullRequestCommentStrategy =
	(typeof REPORT_COMMENT_STRATEGY_VALUES)[number];

export const CONFIDENCE_VALUES = [
	"low",
	"medium",
	"high",
] as const satisfies readonly Confidence[];

export const BITBUCKET_AUTH_TYPE_VALUES = ["basic", "bearer"] as const;

export type BitbucketAuthConfig =
	| {
			type: "bearer";
			token: string;
	  }
	| {
			type: "basic";
			username: string;
			password: string;
	  };

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
		minConfidence: Confidence;
		ignorePaths: string[];
		skipBranchPrefixes: string[];
	};
	ciSummaryPath?: string | undefined;
}

type RepoOverridableGroup = "copilot" | "report" | "review";

type RepoOverridableKey<TGroup extends RepoOverridableGroup> =
	keyof NonNullable<RepoReviewConfig[TGroup]> & keyof ReviewerConfig[TGroup];

type WithOptional<T, TKey extends keyof T> = Omit<T, TKey> & {
	[K in TKey]?: T[K] | undefined;
};

/**
 * Settings fixed by the operator through CLI flags and environment variables.
 * Repo-overridable fields stay unset unless the operator set them, so the
 * trusted repo config and built-in defaults can fill them in later.
 */
export type OperatorConfig = Omit<ReviewerConfig, RepoOverridableGroup> & {
	[TGroup in RepoOverridableGroup]: WithOptional<
		ReviewerConfig[TGroup],
		RepoOverridableKey<TGroup>
	>;
};

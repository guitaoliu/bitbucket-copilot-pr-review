import { readFile } from "node:fs/promises";

import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { OperatorConfig, ReviewerConfig } from "../config/types.ts";
import { REVIEW_PROMPT_VERSION } from "../copilot/prompt-version.ts";
import { parseChangedLines, summarizeDiffStats } from "../git/diff.ts";
import { GitRepository } from "../git/repo.ts";
import { filterChangedFiles } from "../policy/files.ts";
import type { Logger } from "../shared/logger.ts";
import { omitUndefined } from "../shared/object.ts";
import { truncateText } from "../shared/text.ts";
import { loadTrustedRepoConfig } from "./repo-config.ts";
import { buildReviewRevision } from "./revision.ts";
import type { ReviewContext, ReviewScope } from "./types.ts";

export interface PreparedReviewContext {
	config: ReviewerConfig;
	git: GitRepository;
	mergeBaseCommit: string;
}

async function loadCiSummary(
	filePath: string | undefined,
	logger: Logger,
): Promise<string | undefined> {
	if (!filePath) {
		return undefined;
	}

	try {
		const content = await readFile(filePath, "utf8");
		const trimmed = content.trim();
		if (!trimmed) {
			return undefined;
		}
		return truncateText(trimmed, 8000, { suffix: "\n... truncated ..." });
	} catch (error) {
		logger.warn(`Unable to read CI summary file at ${filePath}`, error);
		return undefined;
	}
}

export async function prepareReviewContext(
	operatorConfig: OperatorConfig,
	logger: Logger,
	pr: PullRequestInfo,
): Promise<PreparedReviewContext> {
	const git = new GitRepository(
		operatorConfig.repoRoot,
		logger,
		operatorConfig.gitRemoteName,
	);

	await git.ensurePullRequestCommits(pr);
	const mergeBaseCommit = await git.mergeBase(
		pr.target.latestCommit,
		pr.source.latestCommit,
	);
	const config = await loadTrustedRepoConfig(
		operatorConfig,
		git,
		pr.target.latestCommit,
		logger,
	);

	return {
		config,
		git,
		mergeBaseCommit,
	};
}

export async function buildReviewContext(
	prepared: PreparedReviewContext,
	logger: Logger,
	pr: PullRequestInfo,
): Promise<ReviewContext> {
	const { config, git, mergeBaseCommit } = prepared;
	const headCommit = pr.source.latestCommit;
	const changedFiles = await git.diffChangedFiles(mergeBaseCommit, headCommit);
	const reviewableFiles = filterChangedFiles(
		changedFiles,
		config.review.ignorePaths,
	);
	const ciSummary = await loadCiSummary(config.ciSummaryPath, logger);
	const reviewRevision = buildReviewRevision(
		omitUndefined({
			baseCommit: pr.target.latestCommit,
			headCommit: pr.source.latestCommit,
			mergeBaseCommit,
			ciSummary,
			promptVersion: REVIEW_PROMPT_VERSION,
			copilot: {
				model: config.copilot.model,
				reasoningEffort: config.copilot.reasoningEffort,
			},
			reviewConfig: {
				minConfidence: config.review.minConfidence,
				ignorePaths: [...config.review.ignorePaths],
				skipBranchPrefixes: [...config.review.skipBranchPrefixes],
			},
		}),
	);
	return omitUndefined({
		pr,
		headCommit,
		baseCommit: pr.target.latestCommit,
		mergeBaseCommit,
		reviewRevision,
		diffStats: summarizeDiffStats(changedFiles),
		reviewableFiles,
		ciSummary,
	}) satisfies ReviewContext;
}

export async function loadReviewScope(
	git: Pick<GitRepository, "diffPaths">,
	context: ReviewContext,
): Promise<ReviewScope> {
	const reviewDiff =
		context.reviewableFiles.length === 0
			? ""
			: await git.diffPaths(
					context.mergeBaseCommit,
					context.headCommit,
					context.reviewableFiles.flatMap((file) =>
						file.oldPath ? [file.oldPath, file.path] : [file.path],
					),
					3,
				);
	const changedLinesByPath = parseChangedLines(reviewDiff);
	return {
		...context,
		reviewableFiles: context.reviewableFiles.map((file) => ({
			...file,
			changedLines: changedLinesByPath.get(file.path) ?? [],
		})),
		reviewDiff,
	};
}

import { readFile } from "node:fs/promises";

import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import { applyNumstatDiff } from "../git/diff.ts";
import { GitRepository } from "../git/repo.ts";
import { filterChangedFiles } from "../policy/files.ts";
import type { Logger } from "../shared/logger.ts";
import { omitUndefined } from "../shared/object.ts";
import { truncateText } from "../shared/text.ts";
import { loadTrustedRepoConfig } from "./repo-config.ts";
import { buildReviewRevision } from "./revision.ts";
import type { ReviewContext } from "./types.ts";

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
	config: ReviewerConfig,
	logger: Logger,
	pr: PullRequestInfo,
): Promise<PreparedReviewContext> {
	const git = new GitRepository(config.repoRoot, logger, config.gitRemoteName);

	await git.ensurePullRequestCommits(pr);
	const mergeBaseCommit = await git.mergeBase(
		pr.target.latestCommit,
		pr.source.latestCommit,
	);
	const effectiveConfig = await loadTrustedRepoConfig(
		config,
		git,
		pr.target.latestCommit,
		logger,
	);

	return {
		config: effectiveConfig,
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
	const changedFiles = await git.diffNameStatus(
		mergeBaseCommit,
		pr.source.latestCommit,
	);
	const diffStats = applyNumstatDiff(
		changedFiles,
		await git.diffNumstat(mergeBaseCommit, pr.source.latestCommit),
	);
	const ciSummary = await loadCiSummary(config.ciSummaryPath, logger);
	const reviewRevision = buildReviewRevision(
		omitUndefined({
			baseCommit: pr.target.latestCommit,
			headCommit: pr.source.latestCommit,
			mergeBaseCommit,
			ciSummary,
			promptVersion: "2026-07-precision-markdown-2",
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
	const filtered = filterChangedFiles(changedFiles, config.review.ignorePaths);
	return omitUndefined({
		repoRoot: config.repoRoot,
		pr,
		headCommit: pr.source.latestCommit,
		baseCommit: pr.target.latestCommit,
		mergeBaseCommit,
		reviewRevision,
		rawDiff: "",
		diffStats,
		reviewableFiles: filtered,
		ciSummary,
	}) satisfies ReviewContext;
}

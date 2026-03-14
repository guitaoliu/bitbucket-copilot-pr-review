import { readFile } from "node:fs/promises";

import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import { parseUnifiedDiff } from "../git/diff.ts";
import { GitRepository } from "../git/repo.ts";
import { filterChangedFiles } from "../policy/files.ts";
import type { Logger } from "../shared/logger.ts";
import { omitUndefined } from "../shared/object.ts";
import { truncateText } from "../shared/text.ts";
import { loadTrustedRepoConfig } from "./repo-config.ts";
import { buildReviewRevision } from "./revision.ts";
import type { ReviewContext } from "./types.ts";

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

async function loadRootAgentsInstructions(
	git: GitRepository,
	baseCommit: string,
	logger: Logger,
): Promise<string | undefined> {
	try {
		const content = await git.readFileAtCommit(baseCommit, "AGENTS.md");
		if (content === undefined) {
			logger.debug(
				`No trusted root AGENTS.md found at ${baseCommit}:AGENTS.md`,
			);
			return undefined;
		}

		const trimmed = content.trim();
		if (!trimmed) {
			return undefined;
		}

		logger.info(
			`Loaded root AGENTS.md from trusted base commit ${baseCommit}:AGENTS.md`,
		);

		return truncateText(trimmed, 12000, { suffix: "\n... truncated ..." });
	} catch (error) {
		logger.warn(
			`Unable to read root AGENTS.md from trusted base commit ${baseCommit}`,
			error,
		);
		return undefined;
	}
}

export async function buildReviewContext(
	config: ReviewerConfig,
	logger: Logger,
	pr: PullRequestInfo,
): Promise<{
	config: ReviewerConfig;
	context: ReviewContext;
	git: GitRepository;
}> {
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
	const rawDiff = await git.diff(mergeBaseCommit, pr.source.latestCommit);
	const parsedDiff = parseUnifiedDiff(rawDiff);
	const reviewRevision = buildReviewRevision({
		baseCommit: pr.target.latestCommit,
		mergeBaseCommit,
		rawDiff,
	});
	const filtered = filterChangedFiles(
		parsedDiff.files,
		effectiveConfig.review.maxFiles,
		effectiveConfig.review.ignorePaths,
	);
	const ciSummary = await loadCiSummary(config.ciSummaryPath, logger);
	const rootAgentsInstructions = await loadRootAgentsInstructions(
		git,
		pr.target.latestCommit,
		logger,
	);

	return {
		config: effectiveConfig,
		git,
		context: omitUndefined({
			repoRoot: effectiveConfig.repoRoot,
			pr,
			headCommit: pr.source.latestCommit,
			baseCommit: pr.target.latestCommit,
			mergeBaseCommit,
			reviewRevision,
			rawDiff,
			diffStats: parsedDiff.stats,
			reviewedFiles: filtered.reviewedFiles,
			skippedFiles: filtered.skippedFiles,
			rootAgentsInstructions,
			ciSummary,
		}) satisfies ReviewContext,
	};
}

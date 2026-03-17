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
import type { RepoAgentsInstructions, ReviewContext } from "./types.ts";

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

function buildCandidateAgentsPaths(reviewedPaths: string[]): string[] {
	const candidates = new Set<string>(["AGENTS.md"]);

	for (const reviewedPath of reviewedPaths) {
		const segments = reviewedPath.split("/");
		for (let index = 1; index < segments.length; index += 1) {
			const directory = segments.slice(0, index).join("/");
			if (directory.length > 0) {
				candidates.add(`${directory}/AGENTS.md`);
			}
		}
	}

	return [...candidates].sort((left, right) => {
		const leftDepth = left.split("/").length;
		const rightDepth = right.split("/").length;
		return leftDepth - rightDepth || left.localeCompare(right);
	});
}

export async function loadRepoAgentsInstructions(
	git: GitRepository,
	baseCommit: string,
	reviewedPaths: string[],
	logger: Logger,
): Promise<RepoAgentsInstructions[] | undefined> {
	try {
		const candidates = buildCandidateAgentsPaths(reviewedPaths);
		if (candidates.length === 0) {
			logger.debug(`No trusted AGENTS.md files found at ${baseCommit}`);
			return undefined;
		}

		const loadedInstructions: RepoAgentsInstructions[] = [];
		for (const candidate of candidates) {
			const contentResult = await git.readTextFileAtCommit(
				baseCommit,
				candidate,
			);
			if (contentResult.status !== "ok") {
				continue;
			}

			const trimmed = contentResult.content.trim();
			if (!trimmed) {
				continue;
			}

			const appliesTo =
				candidate === "AGENTS.md"
					? ["."]
					: reviewedPaths.filter((reviewedPath) => {
							const directory = candidate.slice(0, -"/AGENTS.md".length);
							return (
								reviewedPath === directory ||
								reviewedPath.startsWith(`${directory}/`)
							);
						});

			loadedInstructions.push({
				path: candidate,
				appliesTo,
				content: truncateText(trimmed, 12000, {
					suffix: "\n... truncated ...",
				}),
			});
		}

		if (loadedInstructions.length === 0) {
			return undefined;
		}

		logger.info(
			`Loaded ${loadedInstructions.length} trusted AGENTS.md file${loadedInstructions.length === 1 ? "" : "s"} from base commit ${baseCommit}`,
		);

		return loadedInstructions;
	} catch (error) {
		logger.warn(
			`Unable to read trusted AGENTS.md instructions from base commit ${baseCommit}`,
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
	const repoAgentsInstructions = await loadRepoAgentsInstructions(
		git,
		pr.target.latestCommit,
		filtered.reviewedFiles.map((file) => file.path),
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
			repoAgentsInstructions,
			ciSummary,
		}) satisfies ReviewContext,
	};
}

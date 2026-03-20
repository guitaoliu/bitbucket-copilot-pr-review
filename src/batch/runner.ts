import { spawn } from "node:child_process";
import process from "node:process";

import { BitbucketRepositoryClient } from "../bitbucket/client.ts";
import type { PullRequestInfo } from "../bitbucket/types.ts";
import { buildBitbucketPullRequestUrl } from "../config/bitbucket-resolver.ts";
import { GitRepository } from "../git/repo.ts";
import { getPullRequestSkipReason } from "../policy/pull-requests.ts";
import type { ReviewRunOutput } from "../review/output-types.ts";
import { loadTrustedBatchReviewConfig } from "../review/repo-config.ts";
import type { Logger } from "../shared/logger.ts";
import { truncateText } from "../shared/text.ts";
import {
	cleanupBatchWorkspace,
	createBatchGitWorkspace,
	ensureMirrorClone,
	provisionPullRequestWorkspace,
	resolveBatchTempRoot,
} from "./git.ts";
import type {
	BatchReviewConfig,
	BatchReviewMetrics,
	BatchReviewOutput,
	BatchReviewResult,
	BatchWorkspaceLifecycleMetrics,
} from "./types.ts";

interface ProvisionedWorkspaceLike {
	workspaceRoot: string;
	metrics?: BatchReviewResult["workspace"];
	cleanup(): Promise<void>;
}

interface WorkerRunOptions {
	config: BatchReviewConfig;
	pr: PullRequestInfo;
	workspaceRoot: string;
	logger: Logger;
}

interface WorkspaceProvisionOptions {
	workspace: Awaited<ReturnType<typeof createBatchGitWorkspace>>;
	pr: PullRequestInfo;
	cloneUrl: string;
	gitRemoteName: string;
	logger: Logger;
}

export interface BatchReviewDependencies {
	createRepositoryClient?: (
		config: BatchReviewConfig["bitbucket"],
	) => Pick<BitbucketRepositoryClient, "listOpenPullRequests">;
	resolveTempRoot?: (configuredTempRoot: string) => Promise<string>;
	createWorkspace?: typeof createBatchGitWorkspace;
	ensureMirrorClone?: typeof ensureMirrorClone;
	provisionPullRequestWorkspace?: (
		options: WorkspaceProvisionOptions,
	) => Promise<ProvisionedWorkspaceLike>;
	runWorkerForPullRequest?: (
		options: WorkerRunOptions,
	) => Promise<ReviewRunOutput>;
	cleanupBatchWorkspace?: typeof cleanupBatchWorkspace;
	loadTrustedBatchReviewConfig?: typeof loadTrustedBatchReviewConfig;
}

function buildPrefixedLogger(logger: Logger, prefix: string): Logger {
	const withPrefix = (message: string) => `${prefix} ${message}`;

	return {
		debug(message, ...details) {
			logger.debug(withPrefix(message), ...details);
		},
		info(message, ...details) {
			logger.info(withPrefix(message), ...details);
		},
		warn(message, ...details) {
			logger.warn(withPrefix(message), ...details);
		},
		error(message, ...details) {
			logger.error(withPrefix(message), ...details);
		},
		trace(message, ...details) {
			logger.trace(withPrefix(message), ...details);
		},
		json(message) {
			logger.json(message);
		},
	};
}

function formatPullRequestLabel(pr: PullRequestInfo): string {
	return `#${pr.id} ${truncateText(pr.title, 80, { preserveMaxLength: true })}`;
}

function buildWorkerEnvironment(
	config: BatchReviewConfig,
	workspaceRoot: string,
): NodeJS.ProcessEnv {
	return {
		...process.env,
		REPO_ROOT: workspaceRoot,
		GIT_REMOTE_NAME: config.gitRemoteName,
		LOG_LEVEL: config.logLevel,
		REVIEW_FORCE: config.review.forceReview ? "1" : "0",
		BITBUCKET_INSECURE_TLS: config.bitbucket.tls.insecureSkipVerify ? "1" : "0",
	};
}

function appendTruncatedBuffer(
	current: string,
	chunk: string,
	maxChars: number,
): string {
	const combined = `${current}${chunk}`;
	if (combined.length <= maxChars) {
		return combined;
	}

	return combined.slice(-maxChars);
}

function parseWorkerOutput(stdout: string, prId: number): ReviewRunOutput {
	try {
		return JSON.parse(stdout) as ReviewRunOutput;
	} catch (error) {
		throw new Error(
			`Failed to parse worker JSON output for PR #${prId}: ${error instanceof Error ? error.message : String(error)}\n${truncateText(stdout, 1200)}`,
		);
	}
}

function isFailedReviewOutput(output: ReviewRunOutput): boolean {
	return (
		output.skipped === false &&
		(output.publicationStatus === "partial" ||
			output.publicationStatus === "failed")
	);
}

function createWorkspaceLifecycleMetrics(
	tempRoot: string,
): BatchWorkspaceLifecycleMetrics {
	return {
		tempRoot,
		provisioned: 0,
		cleaned: 0,
		retained: 0,
		provisionDurationMsTotal: 0,
		workspaceCleanupDurationMsTotal: 0,
		runRootCleanupDurationMs: 0,
		runRootRemoved: false,
	};
}

async function runWorkerForPullRequest(
	options: WorkerRunOptions,
): Promise<ReviewRunOutput> {
	const workerLogger = buildPrefixedLogger(
		options.logger,
		`[${options.config.repoId}#${options.pr.id}]`,
	);
	const env = buildWorkerEnvironment(options.config, options.workspaceRoot);
	const pullRequestUrl = buildBitbucketPullRequestUrl({
		baseUrl: options.config.bitbucket.baseUrl,
		projectKey: options.config.bitbucket.projectKey,
		repoSlug: options.config.bitbucket.repoSlug,
		prId: options.pr.id,
	});
	if (options.config.bitbucket.auth.type === "bearer") {
		env.BITBUCKET_AUTH_TYPE = "bearer";
		env.BITBUCKET_TOKEN = options.config.bitbucket.auth.token;
		delete env.BITBUCKET_USERNAME;
		delete env.BITBUCKET_PASSWORD;
	} else {
		env.BITBUCKET_AUTH_TYPE = "basic";
		env.BITBUCKET_USERNAME = options.config.bitbucket.auth.username;
		env.BITBUCKET_PASSWORD = options.config.bitbucket.auth.password;
		delete env.BITBUCKET_TOKEN;
	}
	if (options.config.bitbucket.tls.caCertPath !== undefined) {
		env.BITBUCKET_CA_CERT_PATH = options.config.bitbucket.tls.caCertPath;
	} else {
		delete env.BITBUCKET_CA_CERT_PATH;
	}

	const cliEntrypoint = process.argv[1];
	if (!cliEntrypoint) {
		throw new Error(
			"Unable to locate the current CLI entrypoint for batch workers.",
		);
	}

	workerLogger.info(`Starting review worker in ${options.workspaceRoot}`);

	const output = await new Promise<ReviewRunOutput>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				cliEntrypoint,
				"review",
				pullRequestUrl,
				...(options.config.review.dryRun ? ["--dry-run"] : []),
			],
			{
				cwd: process.cwd(),
				env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr = appendTruncatedBuffer(stderr, chunk, 12_000);
			for (const line of chunk.split(/\r?\n/)) {
				if (line.trim().length > 0) {
					workerLogger.info(line);
				}
			}
		});
		child.on("error", (error) => {
			reject(error);
		});
		child.on("close", (code) => {
			try {
				const parsedOutput = parseWorkerOutput(stdout, options.pr.id);
				if (code !== 0) {
					workerLogger.warn(
						`Review worker exited with code ${code} but returned structured JSON output.`,
					);
				}
				workerLogger.info("Review worker completed successfully");
				resolve(parsedOutput);
			} catch (error) {
				if (code !== 0) {
					reject(
						new Error(
							`Review worker for PR #${options.pr.id} exited with code ${code}. ${truncateText(stderr || stdout, 4000)}`,
						),
					);
					return;
				}

				reject(error);
			}
		});
	});

	return output;
}

export { runWorkerForPullRequest };

async function executePullRequestReview(options: {
	config: BatchReviewConfig;
	pr: PullRequestInfo;
	workspace: Awaited<ReturnType<typeof createBatchGitWorkspace>>;
	logger: Logger;
	workspaceMetrics: BatchWorkspaceLifecycleMetrics;
	loadTrustedBatchReviewConfig?: BatchReviewDependencies["loadTrustedBatchReviewConfig"];
	provisionPullRequestWorkspace?: BatchReviewDependencies["provisionPullRequestWorkspace"];
	runWorkerForPullRequest?: BatchReviewDependencies["runWorkerForPullRequest"];
}): Promise<BatchReviewResult> {
	const startedAt = Date.now();
	let provisioned: ProvisionedWorkspaceLike | undefined;
	let effectiveConfig = options.config;
	const prLogger = buildPrefixedLogger(
		options.logger,
		`[${options.config.repoId}#${options.pr.id}]`,
	);

	try {
		const loadTrustedBatchReviewConfigFn =
			options.loadTrustedBatchReviewConfig ?? loadTrustedBatchReviewConfig;
		const targetBaseCommit = options.pr.target.latestCommit;
		if (targetBaseCommit) {
			const git = new GitRepository(
				options.workspace.mirrorRoot,
				options.logger,
				options.config.gitRemoteName,
			);
			effectiveConfig = await loadTrustedBatchReviewConfigFn(
				options.config,
				git,
				targetBaseCommit,
				options.logger,
			);
		}

		const branchSkipReason = getPullRequestSkipReason(
			options.pr,
			effectiveConfig.review.skipBranchPrefixes,
		);
		if (branchSkipReason) {
			prLogger.info(branchSkipReason);
			return {
				prId: options.pr.id,
				title: options.pr.title,
				status: "skipped",
				durationMs: Date.now() - startedAt,
				skipReason: branchSkipReason,
			};
		}

		const cloneUrl = options.pr.target.cloneUrl ?? options.pr.source.cloneUrl;
		if (!cloneUrl) {
			throw new Error("Pull request does not expose a usable clone URL.");
		}

		prLogger.info("Provisioning workspace");

		const provisionPullRequestWorkspaceFn =
			options.provisionPullRequestWorkspace ?? provisionPullRequestWorkspace;
		const runWorkerForPullRequestFn =
			options.runWorkerForPullRequest ?? runWorkerForPullRequest;
		provisioned = await provisionPullRequestWorkspaceFn({
			workspace: options.workspace,
			pr: options.pr,
			cloneUrl,
			gitRemoteName: effectiveConfig.gitRemoteName,
			logger: options.logger,
		});
		if (provisioned.metrics) {
			options.workspaceMetrics.provisioned += 1;
			options.workspaceMetrics.provisionDurationMsTotal +=
				provisioned.metrics.provisionDurationMs;
			prLogger.info(
				`Workspace ready at ${provisioned.workspaceRoot} in ${provisioned.metrics.provisionDurationMs}ms`,
			);
		} else {
			prLogger.info(`Workspace ready at ${provisioned.workspaceRoot}`);
		}
		prLogger.info("Running review");
		const output = await runWorkerForPullRequestFn({
			config: effectiveConfig,
			pr: options.pr,
			workspaceRoot: provisioned.workspaceRoot,
			logger: options.logger,
		});

		return {
			prId: options.pr.id,
			title: options.pr.title,
			status: output.skipped
				? "skipped"
				: isFailedReviewOutput(output)
					? "failed"
					: "reviewed",
			durationMs: Date.now() - startedAt,
			workdir: effectiveConfig.keepWorkdirs
				? provisioned.workspaceRoot
				: undefined,
			workspace: provisioned.metrics,
			output,
			...(isFailedReviewOutput(output)
				? {
						error:
							output.publication?.error?.message ??
							`Review returned publication status ${output.publicationStatus}`,
					}
				: {}),
		};
	} catch (error) {
		prLogger.error(
			`Review failed after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`,
		);
		return {
			prId: options.pr.id,
			title: options.pr.title,
			status: "failed",
			durationMs: Date.now() - startedAt,
			workdir: effectiveConfig.keepWorkdirs
				? provisioned?.workspaceRoot
				: undefined,
			workspace: provisioned?.metrics,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (effectiveConfig.keepWorkdirs && provisioned?.metrics) {
			provisioned.metrics.retained = true;
			options.workspaceMetrics.retained += 1;
			prLogger.info(`Keeping workspace at ${provisioned.workspaceRoot}`);
		}

		if (!effectiveConfig.keepWorkdirs && provisioned) {
			await provisioned.cleanup();
			if (provisioned.metrics) {
				options.workspaceMetrics.cleaned += 1;
				options.workspaceMetrics.workspaceCleanupDurationMsTotal +=
					provisioned.metrics.cleanupDurationMs ?? 0;
				prLogger.info(
					`Removed workspace in ${provisioned.metrics.cleanupDurationMs ?? 0}ms`,
				);
			} else {
				prLogger.info("Removed workspace");
			}
		}
	}
}

async function runWithConcurrency<TItem, TResult>(options: {
	items: readonly TItem[];
	maxParallel: number;
	worker: (item: TItem, index: number) => Promise<TResult>;
}): Promise<TResult[]> {
	const results = new Array<TResult>(options.items.length);
	let nextIndex = 0;

	const runNext = async (): Promise<void> => {
		const currentIndex = nextIndex;
		nextIndex += 1;
		if (currentIndex >= options.items.length) {
			return;
		}

		results[currentIndex] = await options.worker(
			options.items[currentIndex] as TItem,
			currentIndex,
		);
		await runNext();
	};

	const parallelism = Math.min(options.maxParallel, options.items.length);
	await Promise.all(
		Array.from({ length: parallelism }, async () => {
			await runNext();
		}),
	);

	return results;
}

export { runWithConcurrency };

function summarizeBatchResults(
	config: BatchReviewConfig,
	metrics: BatchReviewMetrics,
	results: BatchReviewResult[],
): BatchReviewOutput {
	return {
		repository: {
			repoId: config.repoId,
			projectKey: config.bitbucket.projectKey,
			repoSlug: config.bitbucket.repoSlug,
		},
		totalOpenPullRequests: results.length,
		reviewed: results.filter((result) => result.status === "reviewed").length,
		skipped: results.filter((result) => result.status === "skipped").length,
		failed: results.filter((result) => result.status === "failed").length,
		metrics,
		results,
	};
}

export async function runBatchReview(
	config: BatchReviewConfig,
	logger: Logger,
	dependencies: BatchReviewDependencies = {},
): Promise<BatchReviewOutput> {
	const repoClient =
		dependencies.createRepositoryClient?.(config.bitbucket) ??
		new BitbucketRepositoryClient(config.bitbucket);
	logger.info(
		`Loading open pull requests for ${config.bitbucket.projectKey}/${config.bitbucket.repoSlug}`,
	);
	const resolveTempRoot = dependencies.resolveTempRoot ?? resolveBatchTempRoot;
	const tempRoot = await resolveTempRoot(config.tempRoot);
	logger.info(`Using batch temp root ${tempRoot}`);
	const metrics: BatchReviewMetrics = {
		workspaces: createWorkspaceLifecycleMetrics(tempRoot),
	};
	const pullRequests = await repoClient.listOpenPullRequests();
	logger.info(
		`Discovered ${pullRequests.length} open pull requests for ${config.bitbucket.projectKey}/${config.bitbucket.repoSlug}`,
	);
	if (pullRequests.length === 0) {
		logger.info("No open pull requests found; nothing to review");
		return summarizeBatchResults(config, metrics, []);
	}

	const createWorkspace =
		dependencies.createWorkspace ?? createBatchGitWorkspace;
	const ensureMirrorCloneFn =
		dependencies.ensureMirrorClone ?? ensureMirrorClone;
	const cleanupBatchWorkspaceFn =
		dependencies.cleanupBatchWorkspace ?? cleanupBatchWorkspace;
	const workspace = await createWorkspace({
		tempRoot,
		projectKey: config.bitbucket.projectKey,
		repoSlug: config.bitbucket.repoSlug,
	});
	metrics.workspaces.runRoot = workspace.runRoot;
	logger.info(`Created batch run workspace at ${workspace.runRoot}`);
	const cloneUrl =
		pullRequests.find((pr) => pr.target.cloneUrl)?.target.cloneUrl ??
		pullRequests.find((pr) => pr.source.cloneUrl)?.source.cloneUrl;
	if (!cloneUrl) {
		throw new Error(
			`Repository ${config.repoId} does not expose a usable clone URL for batch review.`,
		);
	}

	try {
		logger.info(`Preparing mirror cache at ${workspace.mirrorRoot}`);
		metrics.mirror = await ensureMirrorCloneFn({ workspace, cloneUrl, logger });
		logger.info(
			`Mirror cache ${metrics.mirror.action} in ${metrics.mirror.durationMs}ms (lock wait ${metrics.mirror.lockWaitMs}ms)`,
		);
		logger.info(
			`Starting batch review of ${pullRequests.length} pull requests with concurrency ${config.maxParallel}`,
		);
		let completedCount = 0;
		const results = await runWithConcurrency({
			items: pullRequests,
			maxParallel: config.maxParallel,
			worker: async (pr, index) => {
				logger.info(
					`Starting PR ${index + 1}/${pullRequests.length}: ${formatPullRequestLabel(pr)}`,
				);
				const result = await executePullRequestReview({
					config,
					pr,
					workspace,
					logger,
					workspaceMetrics: metrics.workspaces,
					loadTrustedBatchReviewConfig:
						dependencies.loadTrustedBatchReviewConfig,
					provisionPullRequestWorkspace:
						dependencies.provisionPullRequestWorkspace,
					runWorkerForPullRequest: dependencies.runWorkerForPullRequest,
				});
				completedCount += 1;
				logger.info(
					`Finished PR ${completedCount}/${pullRequests.length}: ${formatPullRequestLabel(pr)} -> ${result.status} in ${result.durationMs}ms`,
				);
				return result;
			},
		});

		logger.info(
			`Batch review complete: ${results.filter((result) => result.status === "reviewed").length} reviewed, ${results.filter((result) => result.status === "skipped").length} skipped, ${results.filter((result) => result.status === "failed").length} failed`,
		);
		return summarizeBatchResults(config, metrics, results);
	} finally {
		if (config.keepWorkdirs) {
			logger.info(`Keeping batch run workspace at ${workspace.runRoot}`);
		} else {
			logger.info(`Removing batch run workspace at ${workspace.runRoot}`);
		}
		metrics.workspaces.runRootCleanupDurationMs = await cleanupBatchWorkspaceFn(
			{
				workspaceRoot: workspace.runRoot,
				removeRoot: !config.keepWorkdirs,
			},
		);
		metrics.workspaces.runRootRemoved = !config.keepWorkdirs;
		if (config.keepWorkdirs) {
			logger.info("Batch run workspace retained for inspection");
		} else {
			logger.info(
				`Removed batch run workspace in ${metrics.workspaces.runRootCleanupDurationMs}ms`,
			);
		}
	}
}

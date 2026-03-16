import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { PullRequestInfo } from "../bitbucket/types.ts";
import { GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";
import type {
	BatchMirrorMetrics,
	BatchReviewWorkspaceMetrics,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const GIT_BASE_ARGS = ["-c", "core.quotePath=false"];

function sanitizePathSegment(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
	return sanitized.replace(/^-+|-+$/g, "") || "repo";
}

export interface BatchGitWorkspace {
	baseRoot: string;
	runRoot: string;
	cacheRoot: string;
	repoRoot: string;
	repoCacheRoot: string;
	mirrorRoot: string;
}

export async function resolveBatchTempRoot(
	configuredTempRoot: string | undefined,
): Promise<string> {
	const tempRoot = path.resolve(
		configuredTempRoot ?? path.join(tmpdir(), "bitbucket-copilot-pr-review"),
	);
	await mkdir(tempRoot, { recursive: true, mode: 0o700 });
	return tempRoot;
}

export async function createBatchGitWorkspace(options: {
	tempRoot: string;
	projectKey: string;
	repoSlug: string;
}): Promise<BatchGitWorkspace> {
	const baseRoot = path.resolve(options.tempRoot);
	const cacheRoot = path.join(baseRoot, ".cache");
	const repoCacheRoot = path.join(
		cacheRoot,
		`${sanitizePathSegment(options.projectKey)}-${sanitizePathSegment(options.repoSlug)}`,
	);
	const mirrorRoot = path.join(repoCacheRoot, "mirror.git");
	const runRoot = await mkdtemp(path.join(baseRoot, "run-"));
	const repoRoot = path.join(runRoot, "workspaces");

	await mkdir(repoCacheRoot, { recursive: true, mode: 0o700 });
	await mkdir(repoRoot, { recursive: true, mode: 0o700 });

	return {
		baseRoot,
		runRoot,
		cacheRoot,
		repoRoot,
		repoCacheRoot,
		mirrorRoot,
	};
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await stat(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function ensureParentDirectory(targetPath: string): Promise<void> {
	await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
}

async function runGitCommand(options: {
	cwd: string;
	args: string[];
	logger: Logger;
	context: string;
}): Promise<void> {
	try {
		await execFileAsync("git", [...GIT_BASE_ARGS, ...options.args], {
			cwd: options.cwd,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch (error) {
		options.logger.error(`Git operation failed during ${options.context}`);
		throw error;
	}
}

async function acquireLock(lockRoot: string): Promise<() => Promise<void>> {
	const startedAt = Date.now();
	const timeoutMs = 30_000;

	while (true) {
		try {
			await mkdir(lockRoot, { mode: 0o700 });
			return async () => {
				await rmdir(lockRoot);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}

			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error(
					`Timed out waiting for git mirror lock at ${lockRoot}.`,
				);
			}

			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
}

async function acquireLockWithMetrics(lockRoot: string): Promise<{
	release(): Promise<void>;
	lockWaitMs: number;
}> {
	const startedAt = Date.now();
	const release = await acquireLock(lockRoot);
	return {
		release,
		lockWaitMs: Date.now() - startedAt,
	};
}

export async function ensureMirrorClone(options: {
	workspace: BatchGitWorkspace;
	cloneUrl: string;
	logger: Logger;
}): Promise<BatchMirrorMetrics> {
	const { workspace, cloneUrl, logger } = options;
	logger.info(`Waiting for mirror cache lock at ${workspace.repoCacheRoot}`);
	const lock = await acquireLockWithMetrics(
		path.join(workspace.repoCacheRoot, "mirror.lock"),
	);
	const startedAt = Date.now();

	try {
		const mirrorExists = await pathExists(workspace.mirrorRoot);
		if (!mirrorExists) {
			logger.info(`Creating mirror cache from ${cloneUrl}`);
			await ensureParentDirectory(workspace.mirrorRoot);
			await runGitCommand({
				cwd: workspace.repoCacheRoot,
				args: ["clone", "--mirror", cloneUrl, workspace.mirrorRoot],
				logger,
				context: "initial mirror clone",
			});
			return {
				path: workspace.mirrorRoot,
				action: "created",
				durationMs: Date.now() - startedAt,
				lockWaitMs: lock.lockWaitMs,
			};
		}

		logger.info("Refreshing existing mirror cache");
		await runGitCommand({
			cwd: workspace.mirrorRoot,
			args: ["remote", "set-url", "origin", cloneUrl],
			logger,
			context: "mirror remote update",
		});
		await runGitCommand({
			cwd: workspace.mirrorRoot,
			args: ["fetch", "--prune", "--tags", "origin"],
			logger,
			context: "mirror refresh",
		});

		return {
			path: workspace.mirrorRoot,
			action: "refreshed",
			durationMs: Date.now() - startedAt,
			lockWaitMs: lock.lockWaitMs,
		};
	} finally {
		await lock.release();
	}
}

export interface ProvisionedPullRequestWorkspace {
	workspaceRoot: string;
	metrics: BatchReviewWorkspaceMetrics;
	cleanup(): Promise<void>;
}

export async function provisionPullRequestWorkspace(options: {
	workspace: BatchGitWorkspace;
	pr: PullRequestInfo;
	cloneUrl: string;
	gitRemoteName: string;
	logger: Logger;
}): Promise<ProvisionedPullRequestWorkspace> {
	const startedAt = Date.now();
	options.logger.info(
		`Creating workspace clone for PR #${options.pr.id} in ${options.workspace.repoRoot}`,
	);
	const workspaceRoot = await mkdtemp(
		path.join(
			options.workspace.repoRoot,
			`pr-${String(options.pr.id).padStart(6, "0")}-`,
		),
	);
	try {
		await runGitCommand({
			cwd: options.workspace.repoRoot,
			args: [
				"clone",
				"-o",
				options.gitRemoteName,
				"--reference-if-able",
				options.workspace.mirrorRoot,
				"--no-checkout",
				options.cloneUrl,
				workspaceRoot,
			],
			logger: options.logger,
			context: `workspace clone for PR #${options.pr.id}`,
		});

		const git = new GitRepository(
			workspaceRoot,
			options.logger,
			options.gitRemoteName,
		);
		options.logger.info(
			`Fetching PR #${options.pr.id} commits and checking out ${options.pr.source.latestCommit}`,
		);
		await git.ensurePullRequestCommits(options.pr);
		await git.checkoutDetached(options.pr.source.latestCommit);
	} catch (error) {
		await rm(workspaceRoot, { recursive: true, force: true });
		throw error;
	}

	const metrics: BatchReviewWorkspaceMetrics = {
		provisionDurationMs: Date.now() - startedAt,
		retained: false,
	};

	return {
		workspaceRoot,
		metrics,
		async cleanup() {
			options.logger.info(`Deleting workspace ${workspaceRoot}`);
			const cleanupStartedAt = Date.now();
			await rm(workspaceRoot, { recursive: true, force: true });
			metrics.cleanupDurationMs = Date.now() - cleanupStartedAt;
		},
	};
}

export async function cleanupBatchWorkspace(options: {
	workspaceRoot: string;
	removeRoot: boolean;
}): Promise<number> {
	if (!options.removeRoot) {
		return 0;
	}

	const startedAt = Date.now();
	await rm(options.workspaceRoot, { recursive: true, force: true });
	return Date.now() - startedAt;
}

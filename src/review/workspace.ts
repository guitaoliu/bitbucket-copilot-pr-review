import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Logger } from "../shared/logger.ts";

const execFileAsync = promisify(execFile);
const GIT_BASE_ARGS = ["-c", "core.quotePath=false"];

async function runGitCommand(options: {
	repoRoot: string;
	args: string[];
	logger: Logger;
	context: string;
}): Promise<void> {
	try {
		await execFileAsync("git", [...GIT_BASE_ARGS, ...options.args], {
			cwd: options.repoRoot,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch (error) {
		options.logger.error(
			`Git operation failed during ${options.context}`,
			error,
		);
		throw error;
	}
}

export interface DetachedReviewWorkspace {
	workspaceRoot: string;
	cleanup(): Promise<void>;
}

export async function createDetachedReviewWorkspace(options: {
	repoRoot: string;
	headCommit: string;
	logger: Logger;
}): Promise<DetachedReviewWorkspace> {
	const tempRoot = await mkdtemp(
		path.join(tmpdir(), "bitbucket-copilot-pr-review-"),
	);
	const workspaceRoot = path.join(tempRoot, "review-worktree");

	options.logger.info(
		`Creating detached review workspace for ${options.headCommit} at ${workspaceRoot}`,
	);

	try {
		await runGitCommand({
			repoRoot: options.repoRoot,
			args: ["worktree", "add", "--detach", workspaceRoot, options.headCommit],
			logger: options.logger,
			context: `creating detached review workspace ${workspaceRoot}`,
		});
	} catch (error) {
		await rm(tempRoot, { recursive: true, force: true });
		throw error;
	}

	return {
		workspaceRoot,
		async cleanup() {
			const cleanupErrors: string[] = [];

			try {
				await runGitCommand({
					repoRoot: options.repoRoot,
					args: ["worktree", "remove", "--force", workspaceRoot],
					logger: options.logger,
					context: `removing detached review workspace ${workspaceRoot}`,
				});
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error.message : String(error),
				);
			}

			try {
				await rm(tempRoot, { recursive: true, force: true });
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error.message : String(error),
				);
			}

			if (cleanupErrors.length > 0) {
				throw new Error(
					`Failed to clean up detached review workspace at ${workspaceRoot}: ${cleanupErrors.join("; ")}`,
				);
			}
		},
	};
}

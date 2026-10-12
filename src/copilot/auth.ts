import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ReviewerConfig } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";

const execFileAsync = promisify(execFile);

type GitHubTokenSource =
	| "COPILOT_GITHUB_TOKEN"
	| "GH_TOKEN"
	| "GITHUB_TOKEN"
	| "gh auth token";

function readEnvironmentToken(
	env: NodeJS.ProcessEnv,
	envNames: readonly Exclude<GitHubTokenSource, "gh auth token">[],
): { token: string; source: GitHubTokenSource } | undefined {
	for (const envName of envNames) {
		const token = env[envName]?.trim();
		if (token) {
			return { token, source: envName };
		}
	}
	return undefined;
}

async function readGitHubCliToken(
	config: ReviewerConfig & { githubHost: string },
	logger: Logger,
): Promise<{ token: string; source: GitHubTokenSource } | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"gh",
			["auth", "token", "--hostname", config.githubHost],
			{
				cwd: config.repoRoot,
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
				windowsHide: true,
			},
		);
		const token = stdout.trim();
		return token ? { token, source: "gh auth token" } : undefined;
	} catch (error) {
		logger.debug(
			"Unable to resolve GitHub token from GitHub CLI for configured Copilot host",
			{
				githubHost: config.githubHost,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return undefined;
	}
}

export async function resolveCopilotGitHubToken(
	config: ReviewerConfig,
	logger: Logger,
): Promise<string | undefined> {
	const { githubHost } = config;
	if (githubHost === undefined) {
		return undefined;
	}

	const resolved =
		readEnvironmentToken(process.env, ["COPILOT_GITHUB_TOKEN"]) ??
		(await readGitHubCliToken({ ...config, githubHost }, logger)) ??
		readEnvironmentToken(process.env, ["GH_TOKEN", "GITHUB_TOKEN"]);
	if (!resolved) {
		logger.debug(
			"No explicit GitHub token resolved for configured Copilot host; falling back to Copilot CLI login",
			{ githubHost },
		);
		return undefined;
	}

	logger.debug("Resolved GitHub token for configured Copilot host", {
		githubHost,
		source: resolved.source,
	});
	return resolved.token;
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { Logger } from "../shared/logger.ts";
import type { GitTextSearchMatch, GitTextSearchResult } from "./search.ts";
import { parseGitGrepLine } from "./search.ts";

const execFileAsync = promisify(execFile);
const GIT_BASE_ARGS = ["-c", "core.quotePath=false"];

export type GitCommitPathType = "file" | "directory";

export type GitReadTextFileResult =
	| { status: "ok"; content: string }
	| { status: "not_found" }
	| { status: "not_file" }
	| { status: "not_text" };

interface GitCommandOptions {
	allowFailure?: boolean;
}

interface GitCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function isSuccessfulExitCode(exitCode: number): boolean {
	return exitCode === 0;
}

export class GitRepository {
	private readonly repoRoot: string;
	private readonly logger: Logger;
	private readonly remoteName: string;

	constructor(repoRoot: string, logger: Logger, remoteName: string) {
		this.repoRoot = repoRoot;
		this.logger = logger;
		this.remoteName = remoteName;
	}

	private async runGitDetailed(args: string[]): Promise<GitCommandResult> {
		try {
			const { stdout, stderr } = await execFileAsync(
				"git",
				[...GIT_BASE_ARGS, ...args],
				{
					cwd: this.repoRoot,
					encoding: "utf8",
					maxBuffer: 32 * 1024 * 1024,
				},
			);
			return { stdout, stderr, exitCode: 0 };
		} catch (error) {
			const details = error as Error & {
				stderr?: string;
				stdout?: string;
				code?: number;
			};
			if (typeof details.code === "number") {
				return {
					stdout: details.stdout ?? "",
					stderr: details.stderr ?? "",
					exitCode: details.code,
				};
			}

			throw error;
		}
	}

	private async runGit(
		args: string[],
		options?: GitCommandOptions,
	): Promise<string> {
		const result = await this.runGitDetailed(args);
		if (result.exitCode === 0) {
			return result.stdout;
		}

		if (options?.allowFailure) {
			return "";
		}

		throw new Error(
			`Git command failed: git ${args.join(" ")}\n${result.stderr || `exit code ${result.exitCode}`}`,
		);
	}

	private async checkGitObjectExists(spec: string): Promise<boolean> {
		const result = await this.runGitDetailed(["cat-file", "-e", spec]);
		return isSuccessfulExitCode(result.exitCode);
	}

	private async hasCommit(commit: string): Promise<boolean> {
		return this.checkGitObjectExists(`${commit}^{commit}`);
	}

	async getPathTypeAtCommit(
		commit: string,
		filePath: string,
	): Promise<GitCommitPathType | undefined> {
		const result = await this.runGitDetailed([
			"cat-file",
			"-t",
			`${commit}:${filePath}`,
		]);
		if (result.exitCode !== 0) {
			return undefined;
		}

		switch (result.stdout.trim()) {
			case "blob":
				return "file";
			case "tree":
				return "directory";
			default:
				return undefined;
		}
	}

	private async getRemoteUrl(remoteOrUrl: string): Promise<string | undefined> {
		if (remoteOrUrl.includes("://") || remoteOrUrl.startsWith("git@")) {
			return remoteOrUrl;
		}

		const output = await this.runGit(["remote", "get-url", remoteOrUrl], {
			allowFailure: true,
		});
		return output.trim() || undefined;
	}

	private static normalizeRemoteUrl(
		remoteUrl: string | undefined,
	): string | undefined {
		return remoteUrl?.trim().replace(/\.git$/, "");
	}

	async ensurePullRequestCommits(pr: PullRequestInfo): Promise<void> {
		await this.ensureCommitAvailable(
			pr.target.latestCommit,
			pr.target.refId,
			pr.target.cloneUrl,
		);
		await this.ensureCommitAvailable(
			pr.source.latestCommit,
			pr.source.refId,
			pr.source.cloneUrl,
		);
	}

	async ensureCommitAvailable(
		commit: string,
		refId: string,
		cloneUrl?: string,
	): Promise<void> {
		if (await this.hasCommit(commit)) {
			return;
		}

		const attemptErrors: string[] = [];
		const defaultRemoteUrl = GitRepository.normalizeRemoteUrl(
			await this.getRemoteUrl(this.remoteName),
		);
		const attempts: Array<{ source: string; ref: string }> = [
			{ source: this.remoteName, ref: refId },
			{ source: this.remoteName, ref: commit },
		];

		if (cloneUrl) {
			const normalizedCloneUrl = GitRepository.normalizeRemoteUrl(cloneUrl);
			if (!defaultRemoteUrl || normalizedCloneUrl !== defaultRemoteUrl) {
				attempts.push({ source: cloneUrl, ref: refId });
				attempts.push({ source: cloneUrl, ref: commit });
			}
		}

		for (const attempt of attempts) {
			try {
				this.logger.debug(
					`Fetching git object ${commit} using ${attempt.source} ${attempt.ref}`,
				);
				await this.runGit([
					"fetch",
					"--no-tags",
					"--no-prune",
					attempt.source,
					attempt.ref,
				]);
			} catch (error) {
				attemptErrors.push((error as Error).message);
			}

			if (await this.hasCommit(commit)) {
				return;
			}
		}

		throw new Error(
			`Unable to make commit ${commit} available locally. Tried ref ${refId}.\n${attemptErrors.join("\n---\n")}`,
		);
	}

	async mergeBase(baseCommit: string, headCommit: string): Promise<string> {
		return (await this.runGit(["merge-base", baseCommit, headCommit])).trim();
	}

	async diff(baseCommit: string, headCommit: string): Promise<string> {
		return this.runGit([
			"diff",
			"--no-color",
			"--find-renames",
			"--find-copies",
			"--unified=3",
			baseCommit,
			headCommit,
			"--",
		]);
	}

	async listFilesAtCommit(
		commit: string,
		directoryPaths?: string[],
	): Promise<string[]> {
		const pathspecs = (directoryPaths ?? []).filter((path) => path.length > 0);
		const args =
			pathspecs.length > 0
				? ["ls-tree", "-r", "--name-only", commit, "--", ...pathspecs]
				: ["ls-tree", "-r", "--name-only", commit];
		const output = await this.runGit(args);
		if (output.trim().length === 0) {
			return [];
		}

		return [
			...new Set(
				output
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter((line) => line.length > 0),
			),
		];
	}

	async searchTextAtCommit(
		commit: string,
		query: string,
		options?: {
			directoryPaths?: string[];
			limit?: number;
			mode?: "literal" | "regex";
			wholeWord?: boolean;
		},
	): Promise<GitTextSearchResult> {
		const args = ["grep", "-n", "-I", "--full-name"];
		const mode = options?.mode ?? "literal";

		if (mode === "literal") {
			args.push("-F");
			if (options?.wholeWord) {
				args.push("-w");
			}
		} else {
			args.push("-E");
		}

		args.push("-e", query, commit);
		const pathspecs = (options?.directoryPaths ?? []).filter(
			(path) => path.length > 0,
		);
		if (pathspecs.length > 0) {
			args.push("--", ...pathspecs);
		}

		const result = await this.runGitDetailed(args);
		if (result.exitCode !== 0 && result.exitCode !== 1) {
			throw new Error(
				`Git search failed: git ${args.join(" ")}\n${result.stderr || `exit code ${result.exitCode}`}`,
			);
		}

		const lines =
			result.stdout.trim().length > 0
				? result.stdout.trimEnd().split(/\r?\n/)
				: [];
		const matches = lines.flatMap<GitTextSearchMatch>((line) => {
			const parsed = parseGitGrepLine(line);
			return parsed ? [parsed] : [];
		});
		const uniqueMatches = [
			...new Map(
				matches.map((match) => [
					`${match.path}:${match.line}:${match.text}`,
					match,
				]),
			).values(),
		];

		return {
			matches: uniqueMatches,
			truncated: false,
			totalMatches: uniqueMatches.length,
		};
	}

	async readTextFileAtCommit(
		commit: string,
		filePath: string,
	): Promise<GitReadTextFileResult> {
		const pathType = await this.getPathTypeAtCommit(commit, filePath);
		if (!pathType) {
			return { status: "not_found" };
		}

		if (pathType !== "file") {
			return { status: "not_file" };
		}

		const content = await this.runGit(["show", `${commit}:${filePath}`]);
		if (content.includes("\u0000")) {
			return { status: "not_text" };
		}

		return { status: "ok", content };
	}

	async readFileAtCommit(
		commit: string,
		filePath: string,
	): Promise<string | undefined> {
		const result = await this.readTextFileAtCommit(commit, filePath);
		return result.status === "ok" ? result.content : undefined;
	}
}

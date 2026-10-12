import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ReviewGitTelemetry } from "../review/types.ts";
import type { Logger } from "../shared/logger.ts";
import { parseChangedFiles } from "./diff.ts";
import type { ChangedFile } from "./types.ts";

const execFileAsync = promisify(execFile);
const GIT_BASE_ARGS = ["-c", "core.quotePath=false"];

export type GitCommitPathType = "file" | "directory";

export type GitReadTextFileResult =
	| { status: "ok"; content: string }
	| { status: "not_found" }
	| { status: "not_file" }
	| { status: "not_text" };

type GitSearchPatternType = "literal" | "regex";

export class GitInvalidSearchPatternError extends Error {}

export interface GitSearchRequest {
	commit: string;
	patterns: readonly string[];
	patternType: GitSearchPatternType;
	paths: readonly string[];
	excludeGlobs: readonly string[];
	contextLines: number;
	signal?: AbortSignal | undefined;
}

interface GitSearchLine {
	lineNumber: number;
	isMatch: boolean;
	text: string;
}

export interface GitSearchFileMatches {
	path: string;
	groups: GitSearchLine[][];
}

interface GitCommandOptions {
	allowFailure?: boolean;
	signal?: AbortSignal | undefined;
}

interface GitCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function isSuccessfulExitCode(exitCode: number): boolean {
	return exitCode === 0;
}

function parseGrepHeadingOutput(
	commit: string,
	output: string,
): GitSearchFileMatches[] {
	const headingPrefix = `${commit}:`;
	const files: GitSearchFileMatches[] = [];
	let file: GitSearchFileMatches | undefined;
	let group: GitSearchLine[] | undefined;
	for (const line of output.split("\n")) {
		if (line === "") {
			continue;
		}
		if (line === "--") {
			group = undefined;
			continue;
		}
		if (line.startsWith(headingPrefix)) {
			file = { path: line.slice(headingPrefix.length), groups: [] };
			files.push(file);
			group = undefined;
			continue;
		}

		const match = /^(\d+)([:-])([\s\S]*)$/.exec(line);
		if (!match || !file) {
			throw new Error(`Unexpected git grep output line: ${line}`);
		}
		if (!group) {
			group = [];
			file.groups.push(group);
		}
		group.push({
			lineNumber: Number(match[1]),
			isMatch: match[2] === ":",
			text: match[3] ?? "",
		});
	}
	return files;
}

export class GitRepository {
	private readonly repoRoot: string;
	private readonly logger: Logger;
	private readonly remoteName: string;
	private readonly telemetry: ReviewGitTelemetry;

	constructor(repoRoot: string, logger: Logger, remoteName: string) {
		this.repoRoot = repoRoot;
		this.logger = logger;
		this.remoteName = remoteName;
		this.telemetry = {
			byOperation: {},
		};
	}

	private describeGitOperation(args: string[]): string {
		if (args[0] === "remote" && args[1] === "get-url") {
			return "remote.get-url";
		}

		if (args[0] === "cat-file" && args[1] === "-e") {
			return "cat-file.exists";
		}

		if (args[0] === "cat-file" && args[1] === "-t") {
			return "cat-file.type";
		}

		return args[0] ?? "unknown";
	}

	private recordGitOperationDuration(
		operation: string,
		durationMs: number,
	): void {
		const existing = this.telemetry.byOperation[operation] ?? {
			count: 0,
			durationMsTotal: 0,
		};
		this.telemetry.byOperation[operation] = {
			count: existing.count + 1,
			durationMsTotal: existing.durationMsTotal + durationMs,
		};
	}

	getTelemetrySnapshot(): ReviewGitTelemetry {
		return {
			byOperation: Object.fromEntries(
				Object.entries(this.telemetry.byOperation).map(([operation, entry]) => [
					operation,
					{ ...entry },
				]),
			),
		};
	}

	private async runGitDetailed(
		args: string[],
		signal?: AbortSignal,
	): Promise<GitCommandResult> {
		const startedAt = Date.now();
		try {
			const { stdout, stderr } = await execFileAsync(
				"git",
				[...GIT_BASE_ARGS, ...args],
				{
					cwd: this.repoRoot,
					encoding: "utf8",
					maxBuffer: 32 * 1024 * 1024,
					...(signal ? { signal } : {}),
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
		} finally {
			this.recordGitOperationDuration(
				this.describeGitOperation(args),
				Date.now() - startedAt,
			);
		}
	}

	private async runGit(
		args: string[],
		options?: GitCommandOptions,
	): Promise<string> {
		const result = await this.runGitDetailed(args, options?.signal);
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

	private async getPathTypeAtCommit(
		commit: string,
		filePath: string,
		signal?: AbortSignal,
	): Promise<GitCommitPathType | undefined> {
		const result = await this.runGitDetailed(
			["cat-file", "-t", `${commit}:${filePath}`],
			signal,
		);
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

	async diffChangedFiles(
		baseCommit: string,
		headCommit: string,
	): Promise<ChangedFile[]> {
		const output = await this.runGit([
			"diff",
			"--raw",
			"--numstat",
			"-z",
			"--find-renames",
			"--find-copies",
			baseCommit,
			headCommit,
			"--",
		]);
		return parseChangedFiles(output);
	}

	async diffPaths(
		baseCommit: string,
		headCommit: string,
		paths: readonly string[],
		contextLines: number,
	): Promise<string> {
		return this.runGit([
			"diff",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--find-renames",
			"--find-copies",
			`--unified=${contextLines}`,
			baseCommit,
			headCommit,
			"--",
			...paths.map((filePath) => `:(literal)${filePath}`),
		]);
	}

	async searchTextAtCommit(
		request: GitSearchRequest,
	): Promise<GitSearchFileMatches[]> {
		const { commit, patterns, patternType, paths, excludeGlobs } = request;
		const result = await this.runGitDetailed(
			[
				"grep",
				"-n",
				"-I",
				"--heading",
				patternType === "literal" ? "-F" : "-E",
				"-C",
				String(request.contextLines),
				...patterns.flatMap((pattern) => ["-e", pattern]),
				commit,
				"--",
				...paths,
				...excludeGlobs.map((glob) => `:(exclude,glob)${glob}`),
			],
			request.signal,
		);
		if (result.exitCode === 0) {
			return parseGrepHeadingOutput(commit, result.stdout);
		}
		if (result.exitCode === 1) {
			return [];
		}

		const message = `Git search failed at ${commit} using ${patterns.length} ${patternType} patterns across ${paths.length || "all"} pathspecs: ${result.stderr || `exit code ${result.exitCode}`}`;
		if (
			patternType === "regex" &&
			result.stderr.startsWith("fatal: -e option")
		) {
			throw new GitInvalidSearchPatternError(message);
		}

		throw new Error(message);
	}

	async listFilesAtCommit(
		commit: string,
		signal?: AbortSignal,
	): Promise<string[]> {
		const content = await this.runGit(
			["ls-tree", "-r", "-z", "--name-only", commit],
			{ signal },
		);
		return content.split("\0").filter(Boolean);
	}

	async readTextFileAtCommit(
		commit: string,
		filePath: string,
		signal?: AbortSignal,
	): Promise<GitReadTextFileResult> {
		const pathType = await this.getPathTypeAtCommit(commit, filePath, signal);
		if (!pathType) {
			return { status: "not_found" };
		}

		if (pathType !== "file") {
			return { status: "not_file" };
		}

		const content = await this.runGit(["show", `${commit}:${filePath}`], {
			signal,
		});
		if (content.includes("\u0000")) {
			return { status: "not_text" };
		}

		return { status: "ok", content };
	}
}

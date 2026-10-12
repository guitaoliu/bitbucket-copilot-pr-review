import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Logger } from "../shared/logger.ts";
import {
	GitInvalidSearchPatternError,
	GitRepository,
	type GitSearchRequest,
} from "./repo.ts";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

type TestableGitRepository = {
	diffPaths(
		baseCommit: string,
		headCommit: string,
		paths: readonly string[],
		contextLines: number,
	): Promise<string>;
	ensureCommitAvailable(
		commit: string,
		refId: string,
		cloneUrl?: string,
	): Promise<void>;
	getRemoteUrl(remoteOrUrl: string): Promise<string | undefined>;
	hasCommit(commit: string): Promise<boolean>;
	readTextFileAtCommit(
		commit: string,
		filePath: string,
	): Promise<
		| { status: "ok"; content: string }
		| { status: "not_found" }
		| { status: "not_file" }
		| { status: "not_text" }
	>;
	searchTextAtCommit: GitRepository["searchTextAtCommit"];
	listFilesAtCommit: GitRepository["listFilesAtCommit"];
	runGit(args: string[]): Promise<string>;
	runGitDetailed(args: string[]): Promise<{
		stdout: string;
		stderr: string;
		exitCode: number;
	}>;
};

function searchRequest(
	overrides: Partial<GitSearchRequest> & { commit: string },
): GitSearchRequest {
	return {
		patterns: ["needle"],
		patternType: "literal",
		paths: [],
		excludeGlobs: [],
		contextLines: 0,
		...overrides,
	};
}

describe("GitRepository.ensureCommitAvailable", () => {
	it("skips fetch when the commit already exists locally", async () => {
		const fetchCalls: string[][] = [];
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;

		repo.hasCommit = async () => true;
		repo.getRemoteUrl = async () =>
			"https://bitbucket.example.com/scm/proj/repo";
		repo.runGit = async (args) => {
			fetchCalls.push(args);
			return "";
		};

		await repo.ensureCommitAvailable("abc123", "refs/heads/feature");

		assert.deepEqual(fetchCalls, []);
	});

	it("fetches missing commits with --no-prune", async () => {
		const fetchCalls: string[][] = [];
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;
		let hasCommitChecks = 0;

		repo.hasCommit = async () => hasCommitChecks++ > 0;
		repo.getRemoteUrl = async () =>
			"https://bitbucket.example.com/scm/proj/repo";
		repo.runGit = async (args) => {
			fetchCalls.push(args);
			return "";
		};

		await repo.ensureCommitAvailable("abc123", "refs/heads/feature");

		assert.deepEqual(fetchCalls, [
			["fetch", "--no-tags", "--no-prune", "origin", "refs/heads/feature"],
		]);
	});

	it("returns structured non-file results for readTextFileAtCommit", async () => {
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;

		repo.runGitDetailed = async (args) => {
			assert.deepEqual(args, ["cat-file", "-t", "base-123:src"]);
			return { stdout: "tree\n", stderr: "", exitCode: 0 };
		};

		const result = await repo.readTextFileAtCommit("base-123", "src");

		assert.deepEqual(result, { status: "not_file" });
	});

	it("constructs revision-scoped diff and search commands", async () => {
		const calls: string[][] = [];
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;

		repo.runGit = async (args) => {
			calls.push(args);
			return "diff";
		};
		repo.runGitDetailed = async (args) => {
			calls.push(args);
			return { stdout: "head:src/a.ts\n1:needle\n", stderr: "", exitCode: 0 };
		};

		await repo.diffPaths("base", "head", ["src/example[1].ts"], 12);
		await repo.searchTextAtCommit(
			searchRequest({
				commit: "head",
				patterns: ["needle", "second"],
				paths: ["src/**"],
				excludeGlobs: ["**/vendor/**"],
				contextLines: 3,
			}),
		);

		assert.deepEqual(calls, [
			[
				"diff",
				"--no-color",
				"--no-ext-diff",
				"--no-textconv",
				"--find-renames",
				"--find-copies",
				"--unified=12",
				"base",
				"head",
				"--",
				":(literal)src/example[1].ts",
			],
			[
				"grep",
				"-n",
				"-I",
				"--heading",
				"-F",
				"-C",
				"3",
				"-e",
				"needle",
				"-e",
				"second",
				"head",
				"--",
				"src/**",
				":(exclude,glob)**/vendor/**",
			],
		]);
	});

	it("classifies invalid regex search patterns", async () => {
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;

		for (const stderr of [
			"fatal: -e option, '*foo': repetition-operator operand invalid",
			"fatal: -e option, 'a{2,1}': invalid repetition count(s)",
			"fatal: -e option, 'a{256}': maximum repetition exceeds 255",
		]) {
			repo.runGitDetailed = async () => ({ stdout: "", stderr, exitCode: 128 });

			await assert.rejects(
				repo.searchTextAtCommit(
					searchRequest({
						commit: "head-123",
						patternType: "regex",
						paths: ["src/**"],
					}),
				),
				(error: unknown) =>
					error instanceof GitInvalidSearchPatternError &&
					error.message.includes(
						"Git search failed at head-123 using 1 regex patterns across 1 pathspecs",
					),
			);
		}
	});

	it("keeps other search failures actionable", async () => {
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;
		repo.runGitDetailed = async () => ({
			stdout: "",
			stderr: "fatal: bad object head-123",
			exitCode: 128,
		});

		await assert.rejects(
			repo.searchTextAtCommit(
				searchRequest({ commit: "head-123", patternType: "regex" }),
			),
			(error: unknown) =>
				error instanceof Error &&
				!(error instanceof GitInvalidSearchPatternError) &&
				error.message.includes("fatal: bad object head-123"),
		);
	});

	it("lists tracked file names verbatim", async () => {
		const calls: string[][] = [];
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;
		repo.runGit = async (args) => {
			calls.push(args);
			return "AGENTS.md\0src/line\nbreak.ts\0src/example.ts\0";
		};

		assert.deepEqual(await repo.listFilesAtCommit("base-123"), [
			"AGENTS.md",
			"src/line\nbreak.ts",
			"src/example.ts",
		]);
		assert.deepEqual(calls, [
			["ls-tree", "-r", "-z", "--name-only", "base-123"],
		]);
	});

	it("groups search matches by file even when names contain separators", async () => {
		const repoRoot = mkdtempSync(path.join(tmpdir(), "git-search-"));
		try {
			const git = (...args: string[]) =>
				execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
			git("init", "--quiet");
			mkdirSync(path.join(repoRoot, "src"));
			mkdirSync(path.join(repoRoot, "vendor"));
			writeFileSync(
				path.join(repoRoot, "src/a.ts"),
				"before\nneedle\nafter\n\n\n\nneedle\n",
			);
			writeFileSync(path.join(repoRoot, "we:ird-1-2.txt"), "x\nneedle-1:2\n");
			writeFileSync(path.join(repoRoot, "vendor/lib.js"), "needle\n");
			git("add", ".");
			git(
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"--quiet",
				"-m",
				"init",
			);
			const commit = git("rev-parse", "HEAD").trim();
			const repo = new GitRepository(repoRoot, logger, "origin");

			const files = await repo.searchTextAtCommit(
				searchRequest({
					commit,
					excludeGlobs: ["**/vendor/**"],
					contextLines: 1,
				}),
			);

			assert.deepEqual(files, [
				{
					path: "src/a.ts",
					groups: [
						[
							{ lineNumber: 1, isMatch: false, text: "before" },
							{ lineNumber: 2, isMatch: true, text: "needle" },
							{ lineNumber: 3, isMatch: false, text: "after" },
						],
						[
							{ lineNumber: 6, isMatch: false, text: "" },
							{ lineNumber: 7, isMatch: true, text: "needle" },
						],
					],
				},
				{
					path: "we:ird-1-2.txt",
					groups: [
						[
							{ lineNumber: 1, isMatch: false, text: "x" },
							{ lineNumber: 2, isMatch: true, text: "needle-1:2" },
						],
					],
				},
			]);
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	it("aborts in-flight commands instead of reporting empty results", async () => {
		const repoRoot = mkdtempSync(path.join(tmpdir(), "git-abort-"));
		try {
			const git = (...args: string[]) =>
				execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
			git("init", "--quiet");
			writeFileSync(path.join(repoRoot, "example.ts"), "const needle = 1;\n");
			git("add", "example.ts");
			git(
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"--quiet",
				"-m",
				"init",
			);
			const repo = new GitRepository(repoRoot, logger, "origin");
			const isAbortError = (error: unknown) =>
				error instanceof Error && error.name === "AbortError";

			const searchController = new AbortController();
			const search = repo.searchTextAtCommit(
				searchRequest({
					commit: "HEAD",
					patterns: ["missing"],
					signal: searchController.signal,
				}),
			);
			searchController.abort();
			await assert.rejects(search, isAbortError);

			const listController = new AbortController();
			const listing = repo.listFilesAtCommit("HEAD", listController.signal);
			listController.abort();
			await assert.rejects(listing, isAbortError);

			const readController = new AbortController();
			const read = repo.readTextFileAtCommit(
				"HEAD",
				"example.ts",
				readController.signal,
			);
			readController.abort();
			await assert.rejects(read, isAbortError);

			assert.deepEqual(
				await repo.searchTextAtCommit(
					searchRequest({ commit: "HEAD", patterns: ["missing"] }),
				),
				[],
			);
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});
});

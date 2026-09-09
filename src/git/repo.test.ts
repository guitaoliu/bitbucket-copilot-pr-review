import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Logger } from "../shared/logger.ts";
import { GitRepository } from "./repo.ts";

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
	searchTextAtCommit(
		commit: string,
		patterns: readonly string[],
		patternType: "literal" | "regex",
		paths: readonly string[],
		contextLines: number,
	): Promise<string>;
	listFilesAtCommit(commit: string, paths: readonly string[]): Promise<string>;
	runGit(args: string[]): Promise<string>;
	runGitDetailed(args: string[]): Promise<{
		stdout: string;
		stderr: string;
		exitCode: number;
	}>;
};

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
			return { stdout: "match", stderr: "", exitCode: 0 };
		};

		await repo.diffPaths("base", "head", ["src/example[1].ts"], 12);
		await repo.searchTextAtCommit(
			"head",
			["needle", "second"],
			"literal",
			["src/**"],
			3,
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
			],
		]);
	});

	it("includes search scope in Git failures", async () => {
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;
		repo.runGitDetailed = async () => ({
			stdout: "",
			stderr: "invalid regular expression",
			exitCode: 2,
		});

		await assert.rejects(
			repo.searchTextAtCommit("head-123", ["["], "regex", ["src/**"], 3),
			/Git search failed at head-123 using 1 regex patterns across 1 pathspecs: invalid regular expression/,
		);
	});

	it("filters listed files with globs and directory prefixes", async () => {
		const calls: string[][] = [];
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;
		repo.runGit = async (args) => {
			calls.push(args);
			return [
				"AGENTS.md",
				"src/AGENTS.md",
				"src/example.ts",
				"test/example.test.ts",
			].join("\n");
		};

		assert.equal(
			await repo.listFilesAtCommit("base-123", ["**/AGENTS.md"]),
			"AGENTS.md\nsrc/AGENTS.md",
		);
		assert.equal(
			await repo.listFilesAtCommit("base-123", ["src"]),
			"src/AGENTS.md\nsrc/example.ts",
		);
		assert.equal(
			await repo.listFilesAtCommit("base-123", ["**/*.ts"]),
			"src/example.ts\ntest/example.test.ts",
		);
		assert.deepEqual(calls, [
			["ls-tree", "-r", "--name-only", "base-123"],
			["ls-tree", "-r", "--name-only", "base-123"],
			["ls-tree", "-r", "--name-only", "base-123"],
		]);
	});
});

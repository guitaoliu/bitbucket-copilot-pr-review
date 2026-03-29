import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import stream from "node:stream";
import { describe, it } from "node:test";

import type { Logger } from "../shared/logger.ts";
import { GitRepository } from "./repo.ts";

class MockChildProcess extends EventEmitter {
	public readonly stdout = new stream.PassThrough();
	public readonly stderr = new stream.PassThrough();
	public killedSignals: string[] = [];

	kill(signal: string): boolean {
		this.killedSignals.push(signal);
		return true;
	}
}

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

type TestableGitRepository = {
	ensureCommitAvailable(
		commit: string,
		refId: string,
		cloneUrl?: string,
	): Promise<void>;
	getRemoteUrl(remoteOrUrl: string): Promise<string | undefined>;
	hasCommit(commit: string): Promise<boolean>;
	getPathTypeAtCommit(
		commit: string,
		filePath: string,
	): Promise<"file" | "directory" | undefined>;
	readTextFileAtCommit(
		commit: string,
		filePath: string,
	): Promise<
		| { status: "ok"; content: string }
		| { status: "not_found" }
		| { status: "not_file" }
		| { status: "not_text" }
	>;
	listFilesAtCommit(
		commit: string,
		directoryPaths?: string[],
	): Promise<string[]>;
	searchTextAtCommit(
		commit: string,
		query: string,
		options?: {
			directoryPaths?: string[];
			limit?: number;
			mode?: "literal" | "regex";
			wholeWord?: boolean;
		},
	): Promise<{
		matches: Array<{ path: string; line: number; text: string }>;
		truncated: boolean;
		totalMatches: number;
	}>;
	runGitTextSearch(
		args: string[],
		limit?: number,
	): Promise<{
		matches: Array<{ path: string; line: number; text: string }>;
		truncated: boolean;
		totalMatches: number;
	}>;
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

	it("classifies commit paths as files or directories", async () => {
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;

		repo.runGitDetailed = async (args) => {
			assert.deepEqual(args, ["cat-file", "-t", "base-123:src"]);
			return { stdout: "tree\n", stderr: "", exitCode: 0 };
		};

		const result = await repo.getPathTypeAtCommit("base-123", "src");

		assert.equal(result, "directory");
	});

	it("returns structured non-file results for readTextFileAtCommit", async () => {
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;

		repo.getPathTypeAtCommit = async () => "directory";

		const result = await repo.readTextFileAtCommit("base-123", "src");

		assert.deepEqual(result, { status: "not_file" });
	});

	it("passes multiple pathspecs to listFilesAtCommit", async () => {
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;
		const calls: string[][] = [];

		repo.runGit = async (args) => {
			calls.push(args);
			return ["src/a.ts", "test/a.test.ts", "src/a.ts"].join("\n");
		};

		const result = await repo.listFilesAtCommit("base-123", ["src", "test"]);

		assert.deepEqual(calls, [
			["ls-tree", "-r", "--name-only", "base-123", "--", "src", "test"],
		]);
		assert.deepEqual(result, ["src/a.ts", "test/a.test.ts"]);
	});

	it("passes multiple pathspecs to searchTextAtCommit and deduplicates matches", async () => {
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;

		repo.runGitTextSearch = async (args, limit) => {
			assert.deepEqual(args, [
				"grep",
				"-n",
				"-I",
				"--full-name",
				"--null",
				"-F",
				"-e",
				"needle",
				"head-123",
				"--",
				"src",
				"test",
			]);
			assert.equal(limit, undefined);
			return {
				matches: [
					{ path: "src/a.ts", line: 10, text: "needle" },
					{ path: "test/a.test.ts", line: 7, text: "needle" },
				],
				truncated: false,
				totalMatches: 2,
			};
		};

		const result = await repo.searchTextAtCommit("head-123", "needle", {
			directoryPaths: ["src", "test"],
			mode: "literal",
		});

		assert.deepEqual(result, {
			matches: [
				{ path: "src/a.ts", line: 10, text: "needle" },
				{ path: "test/a.test.ts", line: 7, text: "needle" },
			],
			truncated: false,
			totalMatches: 2,
		});
	});

	it("passes the requested limit through to git text search", async () => {
		const repo = new GitRepository(
			"/tmp/repo",
			logger,
			"origin",
		) as unknown as TestableGitRepository;

		repo.runGitTextSearch = async (args, limit) => {
			assert.deepEqual(args, [
				"grep",
				"-n",
				"-I",
				"--full-name",
				"--null",
				"-F",
				"-e",
				"needle",
				"head-123",
			]);
			assert.equal(limit, 1);
			return {
				matches: [{ path: "src/a.ts", line: 10, text: "needle" }],
				truncated: true,
				totalMatches: 2,
			};
		};

		const result = await repo.searchTextAtCommit("head-123", "needle", {
			limit: 1,
			mode: "literal",
		});

		assert.deepEqual(result, {
			matches: [{ path: "src/a.ts", line: 10, text: "needle" }],
			truncated: true,
			totalMatches: 2,
		});
	});

	it("stops parsing git search output once the unique match limit is exceeded", async () => {
		const child = new MockChildProcess();
		const commit = "abcdef12";
		const repo = new GitRepository("/tmp/repo", logger, "origin", {
			spawnProcess: (() =>
				child) as unknown as typeof import("node:child_process").spawn,
		}) as unknown as TestableGitRepository;

		const searchPromise = repo.runGitTextSearch(
			[
				"grep",
				"-n",
				"-I",
				"--full-name",
				"--null",
				"-F",
				"-e",
				"needle",
				commit,
			],
			1,
		);

		child.stdout.write(
			Buffer.from(`${commit}:src/a.ts\u000010\u0000needle\n`, "utf8"),
		);
		child.stdout.write(
			Buffer.from(`${commit}:src/b.ts\u000011\u0000needle\n`, "utf8"),
		);
		child.stdout.end();
		child.stderr.end();
		child.emit("close", 0);

		const result = await searchPromise;

		assert.deepEqual(child.killedSignals, ["SIGTERM"]);
		assert.deepEqual(result, {
			matches: [{ path: "src/a.ts", line: 10, text: "needle" }],
			truncated: true,
			totalMatches: 2,
		});
	});
});

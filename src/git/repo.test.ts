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
});

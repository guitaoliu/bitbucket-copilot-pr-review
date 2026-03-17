import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GitReadTextFileResult, GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";
import { loadRepoAgentsInstructions } from "./context.ts";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

function createGitStub(overrides: Partial<GitRepository> = {}): GitRepository {
	return {
		listFilesAtCommit: async () => [],
		readTextFileAtCommit: async () =>
			({
				status: "not_found",
			}) as GitReadTextFileResult,
		...overrides,
	} as GitRepository;
}

describe("loadRepoAgentsInstructions", () => {
	it("loads root and matching nested AGENTS instructions from the trusted base commit", async () => {
		const git = createGitStub({
			listFilesAtCommit: async () => [
				"AGENTS.md",
				"ui/AGENTS.md",
				"docs/AGENTS.md",
			],
			readTextFileAtCommit: async (_commit, filePath) => {
				switch (filePath) {
					case "AGENTS.md":
						return { status: "ok", content: "root instructions" };
					case "ui/AGENTS.md":
						return { status: "ok", content: "ui instructions" };
					default:
						return { status: "not_found" };
				}
			},
		});

		const instructions = await loadRepoAgentsInstructions(
			git,
			"base-123",
			["ui/src/page.tsx", "server/src/app.ts"],
			logger,
		);

		assert.deepEqual(instructions, [
			{
				path: "AGENTS.md",
				appliesTo: ["."],
				content: "root instructions",
			},
			{
				path: "ui/AGENTS.md",
				appliesTo: ["ui/src/page.tsx"],
				content: "ui instructions",
			},
		]);
	});
});

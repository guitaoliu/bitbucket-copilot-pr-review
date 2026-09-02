import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildReviewSandboxConfig, isSandboxPathAllowed } from "./sandbox.ts";

describe("Copilot shell sandbox", () => {
	it("disables writes, network, developer access, and credential injection", () => {
		const config = buildReviewSandboxConfig(
			["/tmp/review-worktree", "/tmp/repo/.git"],
			"/tmp/review-scratch",
		);

		assert.equal(config.enabled, true);
		assert.equal(config.addCurrentWorkingDirectory, false);
		assert.equal(config.allowDevToolAccess, false);
		assert.deepEqual(config.auth, { git: false, gh: false });
		assert.deepEqual(config.userPolicy?.filesystem?.readonlyPaths, [
			"/tmp/review-worktree",
			"/tmp/repo/.git",
		]);
		assert.deepEqual(config.userPolicy?.filesystem?.readwritePaths, [
			"/tmp/review-scratch",
		]);
		assert.deepEqual(config.userPolicy?.network, {
			allowOutbound: false,
			allowLocalNetwork: false,
		});
		assert.deepEqual(config.userPolicy?.seatbelt, { keychainAccess: false });
	});

	it("allows only configured review and scratch paths", async () => {
		const repoRoot = path.resolve("/tmp/review-worktree");
		const scratchDirectory = path.resolve("/tmp/review-scratch");
		const allowedPaths = [repoRoot, scratchDirectory];

		assert.equal(
			await isSandboxPathAllowed("src/example.ts", repoRoot, allowedPaths),
			true,
		);
		assert.equal(
			await isSandboxPathAllowed(scratchDirectory, repoRoot, allowedPaths),
			true,
		);
		assert.equal(
			await isSandboxPathAllowed("../../etc/passwd", repoRoot, allowedPaths),
			false,
		);
	});

	it("rejects symlinks that escape an allowed directory", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "sandbox-path-test-"));
		const repoRoot = path.join(root, "repo");
		const outsideRoot = path.join(root, "outside");
		await mkdir(repoRoot);
		await mkdir(outsideRoot);
		await symlink(outsideRoot, path.join(repoRoot, "escape"));

		try {
			assert.equal(
				await isSandboxPathAllowed("escape", repoRoot, [repoRoot]),
				false,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

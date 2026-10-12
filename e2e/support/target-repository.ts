import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const BASE_GUIDANCE_MARKER = "Prefer strict equality in comparisons.";
export const RUNTIME_INSTRUCTION_MARKERS = [
	"copilot-instructions-marker",
	"claude-instructions-marker",
];
export const SECRET_VALUES = [
	"base-secret-123",
	"head-secret-456",
	"key-material-789",
];

export interface TargetRepository {
	root: string;
	baseCommit: string;
	headCommit: string;
	pushHeadCommit(files: Record<string, string>): string;
	cleanup(): void;
}

const GIT_ENV = {
	GIT_AUTHOR_NAME: "E2E",
	GIT_AUTHOR_EMAIL: "e2e@example.com",
	GIT_COMMITTER_NAME: "E2E",
	GIT_COMMITTER_EMAIL: "e2e@example.com",
	GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

/**
 * Builds a repository whose base commit carries trusted guidance and secret
 * files, and whose head commit loosens a comparison and rotates a secret.
 * The checkout is left detached at the base commit, as in CI.
 */
export function createTargetRepository(): TargetRepository {
	const root = mkdtempSync(path.join(tmpdir(), "bcpr-e2e-repo-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, ...GIT_ENV },
		}).trim();
	const writeFiles = (files: Record<string, string>) => {
		for (const [filePath, content] of Object.entries(files)) {
			const absolutePath = path.join(root, filePath);
			mkdirSync(path.dirname(absolutePath), { recursive: true });
			writeFileSync(absolutePath, content);
		}
	};
	const commit = (message: string) => {
		git("add", "-A");
		git("commit", "--quiet", "-m", message);
		return git("rev-parse", "HEAD");
	};

	git("init", "--quiet", "--initial-branch", "master");
	writeFiles({
		"AGENTS.md": `# Guidance\n${BASE_GUIDANCE_MARKER}\n`,
		".github/copilot-instructions.md": `${RUNTIME_INSTRUCTION_MARKERS[0]}\n`,
		"CLAUDE.md": `${RUNTIME_INSTRUCTION_MARKERS[1]}\n`,
		"src/app.js": "export function same(a, b) {\n\treturn a === b;\n}\n",
		".env": `SECRET_TOKEN=${SECRET_VALUES[0]}\n`,
		"config/secrets/key.txt": `${SECRET_VALUES[2]}\n`,
	});
	const baseCommit = commit("base");

	git("checkout", "--quiet", "-b", "feature");
	writeFiles({
		"src/app.js":
			"export function same(a, b) {\n\tif (a == b) {\n\t\treturn true;\n\t}\n\treturn false;\n}\n",
		".env": `SECRET_TOKEN=${SECRET_VALUES[1]}\n`,
	});
	const headCommit = commit("loosen equality");
	git("checkout", "--quiet", "--detach", baseCommit);

	return {
		root,
		baseCommit,
		headCommit,
		pushHeadCommit(files) {
			git("checkout", "--quiet", "feature");
			writeFiles(files);
			const commitId = commit("follow-up");
			git("checkout", "--quiet", "--detach", baseCommit);
			return commitId;
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

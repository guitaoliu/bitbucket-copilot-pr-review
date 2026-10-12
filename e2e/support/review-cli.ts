import { spawn } from "node:child_process";
import { type EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = path.join(repositoryRoot, "dist/cli.js");
const fakeModelPreload = fileURLToPath(
	new URL("./use-fake-model.ts", import.meta.url),
);

export const USER_INSTRUCTION_MARKER = "user-instructions-marker";

export interface ReviewCliRun {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	output: Record<string, unknown> | undefined;
}

/**
 * Runs the built CLI with a hermetic environment: no inherited Bitbucket,
 * Copilot, or GitHub settings, and a fresh HOME whose only content is a
 * personal Copilot instruction file that must never reach the model.
 */
export async function runReviewCli(options: {
	repoRoot: string;
	pullRequestUrl: string;
	modelUrl: string;
	args?: string[];
}): Promise<ReviewCliRun> {
	const home = mkdtempSync(path.join(tmpdir(), "bcpr-e2e-home-"));
	mkdirSync(path.join(home, ".copilot"));
	writeFileSync(
		path.join(home, ".copilot/copilot-instructions.md"),
		`${USER_INSTRUCTION_MARKER}\n`,
	);
	try {
		const child = spawn(
			process.execPath,
			[
				"--import",
				fakeModelPreload,
				cliPath,
				"review",
				options.pullRequestUrl,
				...(options.args ?? []),
			],
			{
				cwd: options.repoRoot,
				env: {
					PATH: process.env.PATH,
					HOME: home,
					TMPDIR: process.env.TMPDIR,
					E2E_FAKE_MODEL_URL: options.modelUrl,
					BITBUCKET_TOKEN: "e2e-token",
					LOG_LEVEL: "info",
				},
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk) => {
			stderr += chunk;
		});
		const [exitCode] = (await once(child as EventEmitter, "close")) as [
			number | null,
		];
		let output: Record<string, unknown> | undefined;
		try {
			output = JSON.parse(stdout);
		} catch {
			output = undefined;
		}
		return { exitCode, stdout, stderr, output };
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

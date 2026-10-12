import { spawn } from "node:child_process";
import { type EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = path.join(repositoryRoot, "dist/cli.js");
const fakeModelPreload = fileURLToPath(
	new URL("./use-fake-model.ts", import.meta.url),
);

export interface ReviewCliRun {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	output: Record<string, unknown> | undefined;
}

/**
 * Runs the built CLI with a hermetic environment: no inherited Bitbucket,
 * Copilot, or GitHub settings and an empty HOME, so nothing on the developer
 * machine or CI runner influences the review.
 */
export async function runReviewCli(options: {
	repoRoot: string;
	pullRequestUrl: string;
	modelUrl: string;
}): Promise<ReviewCliRun> {
	const home = mkdtempSync(path.join(tmpdir(), "bcpr-e2e-home-"));
	try {
		const child = spawn(
			process.execPath,
			["--import", fakeModelPreload, cliPath, "review", options.pullRequestUrl],
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

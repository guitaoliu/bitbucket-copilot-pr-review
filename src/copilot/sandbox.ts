import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { CopilotSession } from "@github/copilot-sdk";

const execFileAsync = promisify(execFile);

export type ReviewSandboxConfig = NonNullable<
	Parameters<CopilotSession["rpc"]["options"]["update"]>[0]["sandboxConfig"]
>;

export interface ReviewSandbox {
	config: ReviewSandboxConfig;
	allowedPaths: string[];
	scratchDirectory: string;
	cleanup(): Promise<void>;
}

function compareVersions(left: number[], right: number[]): number {
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

async function assertSandboxSupported(): Promise<void> {
	switch (process.platform) {
		case "darwin":
			try {
				await access("/usr/bin/sandbox-exec");
				await execFileAsync(
					"/usr/bin/sandbox-exec",
					["-p", "(version 1) (allow default)", "/usr/bin/true"],
					{ encoding: "utf8" },
				);
			} catch {
				throw new Error(
					"Copilot shell sandbox cannot start sandbox-exec on this macOS host.",
				);
			}
			return;
		case "linux": {
			let stdout: string;
			try {
				({ stdout } = await execFileAsync("bwrap", ["--version"], {
					encoding: "utf8",
				}));
			} catch {
				throw new Error(
					"Copilot shell sandbox requires bubblewrap 0.5.0 or newer on Linux.",
				);
			}

			const version = stdout.match(/\d+(?:\.\d+)+/)?.[0];
			if (
				!version ||
				compareVersions(version.split(".").map(Number), [0, 5, 0]) < 0
			) {
				throw new Error(
					`Copilot shell sandbox requires bubblewrap 0.5.0 or newer; found ${version ?? "an unknown version"}.`,
				);
			}
			try {
				await execFileAsync(
					"bwrap",
					[
						"--ro-bind",
						"/",
						"/",
						"--proc",
						"/proc",
						"--dev",
						"/dev",
						"--unshare-net",
						"--",
						"true",
					],
					{ encoding: "utf8" },
				);
			} catch {
				throw new Error(
					"Copilot shell sandbox cannot start bubblewrap on this Linux host.",
				);
			}
			return;
		}
		case "win32":
			throw new Error(
				"Copilot shell sandbox support is not yet verified on Windows.",
			);
		default:
			throw new Error(
				`Copilot shell sandbox is not supported on ${process.platform}.`,
			);
	}
}

async function resolveGitPath(
	repoRoot: string,
	argument: string,
): Promise<string> {
	const { stdout } = await execFileAsync("git", ["rev-parse", argument], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return path.resolve(repoRoot, stdout.trim());
}

function buildDeniedCredentialPaths(): string[] {
	const home = homedir();
	return [
		".ssh",
		".aws",
		".docker",
		".kube",
		".config/gh",
		".npmrc",
		".netrc",
		".pypirc",
		".m2/settings.xml",
		".gradle/gradle.properties",
	].map((entry) => path.join(home, entry));
}

export function buildReviewSandboxConfig(
	readonlyPaths: string[],
	scratchDirectory: string,
): ReviewSandboxConfig {
	return {
		enabled: true,
		addCurrentWorkingDirectory: false,
		allowDevToolAccess: false,
		auth: { git: false, gh: false },
		userPolicy: {
			filesystem: {
				readonlyPaths,
				readwritePaths: [scratchDirectory],
				deniedPaths: buildDeniedCredentialPaths(),
			},
			network: {
				allowOutbound: false,
				allowLocalNetwork: false,
			},
			seatbelt: { keychainAccess: false },
		},
	};
}

export async function createReviewSandbox(
	repoRoot: string,
): Promise<ReviewSandbox> {
	await assertSandboxSupported();

	const sandboxRoot = await mkdtemp(
		path.join(tmpdir(), "bitbucket-copilot-shell-"),
	);
	const scratchDirectory = path.join(sandboxRoot, "scratch");
	await mkdir(scratchDirectory);

	try {
		const [gitDirectory, gitCommonDirectory, canonicalScratchDirectory] =
			await Promise.all([
				resolveGitPath(repoRoot, "--absolute-git-dir"),
				resolveGitPath(repoRoot, "--git-common-dir"),
				realpath(scratchDirectory),
			]);
		const readonlyPaths = [
			...new Set(
				await Promise.all(
					[repoRoot, gitDirectory, gitCommonDirectory].map((filePath) =>
						realpath(filePath),
					),
				),
			),
		];
		const allowedPaths = [...readonlyPaths, canonicalScratchDirectory];

		return {
			config: buildReviewSandboxConfig(
				readonlyPaths,
				canonicalScratchDirectory,
			),
			allowedPaths,
			scratchDirectory: canonicalScratchDirectory,
			async cleanup() {
				await rm(sandboxRoot, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(sandboxRoot, { recursive: true, force: true });
		throw error;
	}
}

export async function isSandboxPathAllowed(
	filePath: string,
	repoRoot: string,
	allowedPaths: string[],
): Promise<boolean> {
	const resolvedPath = path.resolve(repoRoot, filePath);
	const canonicalPath = await realpath(resolvedPath).catch(() => resolvedPath);
	return allowedPaths.some(
		(allowedPath) =>
			canonicalPath === allowedPath ||
			canonicalPath.startsWith(`${allowedPath}${path.sep}`),
	);
}

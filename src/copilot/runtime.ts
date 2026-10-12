import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
	CopilotClient,
	CopilotClientOptions,
	CopilotSession,
	SessionConfig,
	SessionEvent,
} from "@github/copilot-sdk";
import { RuntimeConnection } from "@github/copilot-sdk";
import packageJson from "../../package.json" with { type: "json" };
import type { ReviewerConfig } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";
import { omitUndefined } from "../shared/object.ts";

const require = createRequire(import.meta.url);
const copilotCliPath = require.resolve("@github/copilot/npm-loader.js");

export const COPILOT_APPLICATION_NAME = packageJson.name;

export type CopilotClientLike = Pick<
	CopilotClient,
	"start" | "createSession" | "stop"
>;

export type CopilotReply = { data: { content: string } } | undefined;

export interface CopilotSessionLike {
	rpc: {
		usage: Pick<CopilotSession["rpc"]["usage"], "getMetrics">;
	};
	sendAndWait(
		options: Parameters<CopilotSession["sendAndWait"]>[0],
		timeout?: Parameters<CopilotSession["sendAndWait"]>[1],
	): Promise<CopilotReply>;
	on(handler: (event: SessionEvent) => void): () => void;
	disconnect(): Promise<void>;
}

type CopilotStage = "client startup" | "session creation" | "review request";

export function buildCopilotClientOptions(
	config: ReviewerConfig,
	gitHubToken: string | undefined,
	runtimeDirectory: string,
): CopilotClientOptions {
	return omitUndefined({
		workingDirectory: runtimeDirectory,
		mode: "copilot-cli",
		connection: RuntimeConnection.forStdio({
			path: copilotCliPath,
			args: [
				"--experimental",
				"--no-remote",
				"--no-remote-export",
				"--disable-builtin-mcps",
				"--no-custom-instructions",
				"--no-auto-update",
				`--log-dir=${config.copilot.runtimeLogDir ?? path.join(runtimeDirectory, "logs")}`,
			],
		}),
		logLevel: config.logLevel === "debug" ? "debug" : "error",
		clientInfo: {
			applicationName: COPILOT_APPLICATION_NAME,
			applicationVersion: packageJson.version,
		},
		env:
			config.githubHost !== undefined
				? {
						...process.env,
						COPILOT_GH_HOST: config.githubHost,
						GH_HOST: config.githubHost,
					}
				: undefined,
		gitHubToken,
		useLoggedInUser: gitHubToken !== undefined ? false : undefined,
	}) satisfies CopilotClientOptions;
}

export function wrapCopilotStageError(
	error: unknown,
	config: ReviewerConfig,
	stage: CopilotStage,
): Error {
	const cause = error instanceof Error ? error : new Error(String(error));
	if (
		cause.message.includes("Unexpected token '<'") ||
		cause.message.includes("<!DOCTYPE")
	) {
		const authHint = config.githubHost
			? `Verify Copilot auth for ${config.githubHost}, and confirm \`gh auth status --hostname ${config.githubHost}\` succeeds or that a valid Copilot token is configured.`
			: "Verify your Copilot login. If your account uses a GitHub Enterprise Cloud data residency host (`*.ghe.com`), set `GH_HOST` to that hostname before running the reviewer.";
		return new Error(
			`Copilot ${stage} failed because the runtime returned HTML instead of JSON. This usually means Copilot authentication or GitHub host selection is wrong. ${authHint}`,
			{ cause },
		);
	}

	return new Error(`Copilot ${stage} failed: ${cause.message}`, { cause });
}

/**
 * The runtime reads instruction files from its working directory, so it runs in
 * an empty directory; repository content is reachable only through review tools.
 */
export async function withRuntimeDirectory<T>(
	config: ReviewerConfig,
	logger: Logger,
	run: (runtimeDirectory: string) => Promise<T>,
): Promise<T> {
	const { runtimeLogDir } = config.copilot;
	if (runtimeLogDir !== undefined) {
		await mkdir(runtimeLogDir, { recursive: true });
		logger.info(`Writing Copilot runtime logs to ${runtimeLogDir}`);
	}

	const runtimeDirectory = await mkdtemp(
		path.join(tmpdir(), "bitbucket-copilot-pr-review-runtime-"),
	);
	try {
		return await run(runtimeDirectory);
	} finally {
		try {
			await rm(runtimeDirectory, { recursive: true, force: true });
		} catch (error) {
			logger.warn(
				`Failed to remove Copilot runtime directory ${runtimeDirectory}`,
				error,
			);
		}
	}
}

export async function withCopilotSession<T>(
	options: {
		config: ReviewerConfig;
		logger: Logger;
		client: CopilotClientLike;
		sessionConfig: SessionConfig;
		onCleanupError(error: Error): void;
	},
	run: (session: CopilotSessionLike) => Promise<T>,
): Promise<T> {
	const { client, config, logger } = options;
	try {
		await client.start();
	} catch (error) {
		throw wrapCopilotStageError(error, config, "client startup");
	}

	try {
		let session: CopilotSessionLike;
		try {
			session = await client.createSession(options.sessionConfig);
		} catch (error) {
			throw wrapCopilotStageError(error, config, "session creation");
		}

		try {
			return await run(session);
		} finally {
			await session.disconnect();
		}
	} finally {
		for (const error of await client.stop()) {
			options.onCleanupError(error);
			logger.warn("Copilot client cleanup reported an error", error);
		}
	}
}

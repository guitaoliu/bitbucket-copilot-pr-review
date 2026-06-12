import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	PermissionRequest,
	PermissionRequestMcp,
	PermissionRequestRead,
	SessionConfig,
	SessionEventHandler,
} from "@github/copilot-sdk";
import type { ReviewerConfig } from "../config/types.ts";
import type { ChangedFile, HunkSummary } from "../git/types.ts";
import type { ReviewContext } from "../review/types.ts";
import type { Logger } from "../shared/logger.ts";
import { runCopilotReview } from "./engine.ts";
import { buildSystemMessage } from "./prompt.ts";

type HookToolResult = {
	resultType: string;
	textResultForLlm?: string;
	[key: string]: unknown;
};

const config: ReviewerConfig = {
	repoRoot: "/tmp/repo",
	gitRemoteName: "origin",
	logLevel: "info",
	bitbucket: {
		baseUrl: "https://bitbucket.example.com",
		projectKey: "PROJ",
		repoSlug: "repo",
		prId: 123,
		auth: { type: "bearer", token: "token" },
		tls: { insecureSkipVerify: false },
	},
	copilot: {
		model: "gpt-5.3-codex",
		reasoningEffort: "xhigh",
		timeoutMs: 1800000,
	},
	report: {
		key: "copilot-review",
		title: "Copilot PR Review",
		reporter: "GitHub Copilot",
		commentTag: "copilot-pr-review",
		commentStrategy: "recreate",
	},
	review: {
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
		maxFiles: 100,
		maxFindings: 3,
		minConfidence: "high",
		maxPatchChars: 12000,
		defaultFileSliceLines: 250,
		maxFileSliceLines: 400,
		ignorePaths: [],
		skipBranchPrefixes: ["renovate/"],
	},
};

function createLoggerSpy(): {
	logger: Logger;
	infoEntries: Array<{ message: string; details: unknown[] }>;
	warnEntries: Array<{ message: string; details: unknown[] }>;
} {
	const infoEntries: Array<{ message: string; details: unknown[] }> = [];
	const warnEntries: Array<{ message: string; details: unknown[] }> = [];

	return {
		logger: {
			debug() {},
			info(message, ...details) {
				infoEntries.push({ message, details });
			},
			warn(message, ...details) {
				warnEntries.push({ message, details });
			},
			error() {},
			trace() {},
			json() {},
		},
		infoEntries,
		warnEntries,
	};
}

function createChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
	const defaultHunk: HunkSummary = {
		oldStart: 1,
		oldLines: 1,
		newStart: 1,
		newLines: 1,
		header: "",
		changedLines: [1],
	};

	return {
		path: "src/example.ts",
		status: "modified",
		patch: "diff --git a/src/example.ts b/src/example.ts",
		changedLines: [1],
		hunks: [defaultHunk],
		additions: 1,
		deletions: 0,
		isBinary: false,
		...overrides,
	};
}

function createReviewContext(): ReviewContext {
	return {
		repoRoot: "/tmp/repo",
		pr: {
			id: 123,
			version: 1,
			state: "OPEN",
			title: "Test PR",
			description: "",
			source: {
				repositoryId: 1,
				projectKey: "PROJ",
				repoSlug: "repo",
				refId: "refs/heads/feature",
				displayId: "feature",
				latestCommit: "head-123",
			},
			target: {
				repositoryId: 1,
				projectKey: "PROJ",
				repoSlug: "repo",
				refId: "refs/heads/main",
				displayId: "main",
				latestCommit: "base-123",
			},
		},
		headCommit: "head-123",
		baseCommit: "base-123",
		mergeBaseCommit: "base-123",
		reviewRevision: "review-rev-123",
		rawDiff: "",
		diffStats: { fileCount: 1, additions: 1, deletions: 0 },
		reviewedFiles: [createChangedFile()],
		skippedFiles: [],
	};
}

function createSdkToolResult(result: Record<string, unknown>): HookToolResult {
	return {
		textResultForLlm: JSON.stringify(result),
		resultType: "success",
	};
}

async function invokeSessionTool(
	configArg: SessionConfig,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const tool = configArg.tools?.find(
		(candidate) => candidate.name === toolName,
	);
	assert.ok(tool, `Expected session tool ${toolName} to exist`);
	return (
		tool.handler as (
			input: Record<string, unknown>,
			invocation: {
				sessionId: string;
				toolCallId: string;
				toolName: string;
				arguments: unknown;
			},
		) => Promise<unknown>
	)(args, {
		sessionId: "session-1",
		toolCallId: `${toolName}-call`,
		toolName,
		arguments: args,
	});
}

describe("runCopilotReview", () => {
	it("passes the explicit bundled cli path into the created Copilot client", async () => {
		const context = createReviewContext();
		const createdOptions: Array<Record<string, unknown>> = [];

		const session = {
			on() {
				return () => {};
			},
			async sendAndWait() {
				return { data: { content: "Looks good." } };
			},
			async disconnect() {},
		};

		const outcome = await runCopilotReview(
			config,
			context,
			{} as never,
			createLoggerSpy().logger,
			{
				resolveCliPath: () => "/tmp/node_modules/@github/copilot/index.js",
				createCopilotClient(options) {
					createdOptions.push(options as Record<string, unknown>);

					return {
						async start() {},
						async createSession() {
							throw new Error("createSession should not be called directly");
						},
						async stop() {
							return [];
						},
					};
				},
				async createReviewSession() {
					return session;
				},
			},
		);

		assert.equal(createdOptions.length, 1);
		assert.deepEqual(createdOptions[0]?.connection, {
			args: undefined,
			kind: "stdio",
			path: "/tmp/node_modules/@github/copilot/index.js",
		});
		assert.equal(createdOptions[0]?.workingDirectory, config.repoRoot);
		assert.equal(createdOptions[0]?.mode, "copilot-cli");
		assert.equal(outcome.findings.length, 0);
		assert.equal(outcome.assistantMessage, "Looks good.");
	});

	it("passes a resolved GitHub token into the created Copilot client", async () => {
		const context = createReviewContext();
		const createdOptions: Array<Record<string, unknown>> = [];

		const session = {
			on() {
				return () => {};
			},
			async sendAndWait() {
				return { data: { content: "Looks good." } };
			},
			async disconnect() {},
		};

		await runCopilotReview(
			{
				...config,
				githubHost: "tenant.ghe.com",
			},
			context,
			{} as never,
			createLoggerSpy().logger,
			{
				resolveCliPath: () => "/tmp/node_modules/@github/copilot/index.js",
				resolveGitHubToken: async () => "gho_test-token",
				createCopilotClient(options) {
					createdOptions.push(options as Record<string, unknown>);

					return {
						async start() {},
						async createSession() {
							throw new Error("createSession should not be called directly");
						},
						async stop() {
							return [];
						},
					};
				},
				async createReviewSession() {
					return session;
				},
			},
		);

		assert.equal(createdOptions.length, 1);
		assert.equal(createdOptions[0]?.gitHubToken, "gho_test-token");
		assert.equal(createdOptions[0]?.useLoggedInUser, false);
	});

	it("sends one review request without managed coverage continuation", async () => {
		const context = createReviewContext();
		const logSpy = createLoggerSpy();
		let sendCount = 0;

		await runCopilotReview(config, context, {} as never, logSpy.logger, {
			resolveCliPath: () => "/tmp/node_modules/@github/copilot/index.js",
			createCopilotClient() {
				return {
					async start() {},
					async createSession(configArg: SessionConfig) {
						return {
							on() {
								return () => {};
							},
							async sendAndWait() {
								sendCount += 1;
								if (sendCount === 1) {
									await configArg.hooks?.onPostToolUse?.(
										{
											toolName: "get_pr_overview",
											toolArgs: {},
											toolResult: createSdkToolResult({
												reviewedFiles: [{ path: "src/example.ts" }],
												skippedFiles: [],
											}),
										} as never,
										{ sessionId: "session-1" } as never,
									);
									await configArg.hooks?.onPostToolUse?.(
										{
											toolName: "bash",
											toolArgs: {},
											toolResult: createSdkToolResult({}),
										} as never,
										{ sessionId: "session-1" } as never,
									);
									await invokeSessionTool(configArg, "record_pr_summary", {
										summary: "Refactors the reviewed behavior.",
									});
									await configArg.hooks?.onPostToolUse?.(
										{
											toolName: "record_pr_summary",
											toolArgs: {
												summary: "Refactors the reviewed behavior.",
											},
											toolResult: createSdkToolResult({}),
										} as never,
										{ sessionId: "session-1" } as never,
									);
								}

								return { data: { content: "Looks good." } };
							},
							async disconnect() {},
						} as never;
					},
					async stop() {
						return [];
					},
				} as never;
			},
		});

		assert.equal(sendCount, 1);
		assert.deepEqual(
			logSpy.infoEntries.filter((entry) =>
				entry.message.startsWith(
					"Continuing Copilot review because review completion signals are incomplete",
				),
			),
			[],
		);
		assert.deepEqual(logSpy.warnEntries, []);
	});

	it("does not continue when the model records no structured review output", async () => {
		const context = createReviewContext();
		const logSpy = createLoggerSpy();
		let sendCount = 0;

		await runCopilotReview(config, context, {} as never, logSpy.logger, {
			resolveCliPath: () => "/tmp/node_modules/@github/copilot/index.js",
			createCopilotClient() {
				return {
					async start() {},
					async createSession() {
						return {
							on() {
								return () => {};
							},
							async sendAndWait() {
								sendCount += 1;
								return { data: { content: "Looks good." } };
							},
							async disconnect() {},
						} as never;
					},
					async stop() {
						return [];
					},
				} as never;
			},
		});

		assert.equal(sendCount, 1);
		assert.deepEqual(
			logSpy.infoEntries.filter((entry) =>
				entry.message.startsWith(
					"Continuing Copilot review because review completion signals are incomplete",
				),
			),
			[],
		);
		assert.deepEqual(logSpy.warnEntries, []);
	});

	it("wraps Copilot startup HTML parse failures with actionable auth guidance", async () => {
		const context = createReviewContext();
		let stopCalls = 0;

		await assert.rejects(
			runCopilotReview(
				{
					...config,
					githubHost: "tenant.ghe.com",
				},
				context,
				{} as never,
				createLoggerSpy().logger,
				{
					createCopilotClient() {
						return {
							async start() {
								throw new SyntaxError(
									"Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
								);
							},
							async createSession() {
								throw new Error("createSession should not be called directly");
							},
							async stop() {
								stopCalls += 1;
								return [];
							},
						};
					},
				},
			),
			(error) => {
				assert(error instanceof Error);
				assert.match(
					error.message,
					/Copilot client startup failed because the runtime returned HTML instead of JSON/,
				);
				assert.match(error.message, /tenant\.ghe\.com/);
				assert(error.cause instanceof SyntaxError);
				return true;
			},
		);

		assert.equal(stopCalls, 0);
	});

	it("passes system prompt customization and readonly permission config into session creation", async () => {
		const context = createReviewContext();
		const createdSessionConfigs: SessionConfig[] = [];
		const sessionEventHandlers: SessionEventHandler[] = [];
		const logSpy = createLoggerSpy();

		await runCopilotReview(config, context, {} as never, logSpy.logger, {
			resolveCliPath: () => "/tmp/node_modules/@github/copilot/index.js",
			createCopilotClient() {
				return {
					async start() {},
					async createSession(configArg: SessionConfig) {
						createdSessionConfigs.push(configArg);

						return {
							on(handler: SessionEventHandler) {
								sessionEventHandlers.push(handler);
								return () => {};
							},
							async sendAndWait() {
								return { data: { content: "Looks good." } };
							},
							async disconnect() {},
						} as never;
					},
					async stop() {
						return [];
					},
				} as never;
			},
		});

		assert.equal(createdSessionConfigs.length, 1);
		assert.deepEqual(
			createdSessionConfigs[0]?.systemMessage,
			buildSystemMessage(config),
		);
		assert.deepEqual(createdSessionConfigs[0]?.availableTools, [
			"builtin:bash",
			"custom:get_pr_overview",
			"custom:record_pr_summary",
			"custom:emit_finding",
		]);
		const permissionHandler = createdSessionConfigs[0]?.onPermissionRequest;
		assert.equal(typeof permissionHandler, "function");
		assert(permissionHandler);
		assert.equal(sessionEventHandlers.length, 1);

		const allowed = await permissionHandler(
			{
				canOfferSessionApproval: false,
				kind: "shell",
				commands: [{ identifier: "git", readOnly: true }],
				fullCommandText: "git diff --stat",
				intention: "Inspect diff",
				hasWriteFileRedirection: false,
				possiblePaths: ["/tmp/repo/src/file.ts"],
				possibleUrls: [],
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(allowed, { kind: "approve-once" });

		const allowedSed = await permissionHandler(
			{
				canOfferSessionApproval: false,
				kind: "shell",
				commands: [{ identifier: "sed", readOnly: true }],
				fullCommandText: "sed -n '1,80p' src/file.ts",
				intention: "Inspect source",
				hasWriteFileRedirection: false,
				possiblePaths: ["/tmp/repo/src/file.ts"],
				possibleUrls: [],
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(allowedSed, { kind: "approve-once" });

		const allowedGitShow = await permissionHandler(
			{
				canOfferSessionApproval: false,
				kind: "shell",
				commands: [{ identifier: "git", readOnly: true }],
				fullCommandText: "git show HEAD:src/file.ts",
				intention: "Inspect source at commit",
				hasWriteFileRedirection: false,
				possiblePaths: ["/tmp/repo/src/file.ts"],
				possibleUrls: [],
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(allowedGitShow, { kind: "approve-once" });

		const deniedGitShowSecretPath = await permissionHandler(
			{
				canOfferSessionApproval: false,
				kind: "shell",
				commands: [{ identifier: "git", readOnly: true }],
				fullCommandText: "git show HEAD:config/.env",
				intention: "Inspect source at commit",
				hasWriteFileRedirection: false,
				possiblePaths: [],
				possibleUrls: [],
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedGitShowSecretPath, {
			kind: "reject",
			feedback:
				"Readonly review mode blocks shell access to potential secret-bearing path config/.env.",
		});

		for (const fullCommandText of [
			"git show HEAD:'config/.env'",
			"git show :config/.env",
		]) {
			const deniedQuotedGitShowSecretPath = await permissionHandler(
				{
					canOfferSessionApproval: false,
					kind: "shell",
					commands: [{ identifier: "git", readOnly: true }],
					fullCommandText,
					intention: "Inspect source at commit",
					hasWriteFileRedirection: false,
					possiblePaths: [],
					possibleUrls: [],
				} as PermissionRequest,
				{ sessionId: "session-1" },
			);
			assert.deepEqual(deniedQuotedGitShowSecretPath, {
				kind: "reject",
				feedback:
					"Readonly review mode blocks shell access to potential secret-bearing path config/.env.",
			});
		}

		for (const possibleRootPath of ["/tmp/repo", "."]) {
			const allowedRepoRootInspection = await permissionHandler(
				{
					canOfferSessionApproval: false,
					kind: "shell",
					commands: [{ identifier: "ls", readOnly: true }],
					fullCommandText: "ls .",
					intention: "Inspect repo root",
					hasWriteFileRedirection: false,
					possiblePaths: [possibleRootPath],
					possibleUrls: [],
				} as PermissionRequest,
				{ sessionId: "session-1" },
			);
			assert.deepEqual(allowedRepoRootInspection, { kind: "approve-once" });
		}

		const deniedRead = await permissionHandler(
			{
				kind: "read",
				intention: "Inspect source",
				path: "/tmp/repo/src/file.ts",
			} satisfies PermissionRequestRead,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedRead, {
			kind: "reject",
			feedback:
				"Readonly review mode does not allow read permissions. Use approved git or shell inspection commands instead.",
		});

		const deniedReadOutsideRepo = await permissionHandler(
			{
				kind: "read",
				intention: "Inspect outside source",
				path: "/tmp/outside/file.ts",
			} satisfies PermissionRequestRead,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedReadOutsideRepo, {
			kind: "reject",
			feedback:
				"Readonly review mode does not allow read permissions. Use approved git or shell inspection commands instead.",
		});

		const deniedMcp = await permissionHandler(
			{
				kind: "mcp",
				serverName: "github",
				toolName: "github/search_code",
				toolTitle: "Search code",
				args: { query: "repo:test test" },
				readOnly: true,
			} satisfies PermissionRequestMcp,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedMcp, {
			kind: "reject",
			feedback: "Readonly review mode does not allow mcp permissions.",
		});

		for (const commandIdentifier of ["env", "xargs"]) {
			const deniedCommand = await permissionHandler(
				{
					canOfferSessionApproval: false,
					kind: "shell",
					commands: [{ identifier: commandIdentifier, readOnly: true }],
					fullCommandText: commandIdentifier,
					intention: "Inspect command behavior",
					hasWriteFileRedirection: false,
					possiblePaths: [],
					possibleUrls: [],
				} as PermissionRequest,
				{ sessionId: "session-1" },
			);
			assert.deepEqual(deniedCommand, {
				kind: "reject",
				feedback:
					"Readonly review mode allows only approved readonly inspection commands.",
			});
		}

		const denied = await permissionHandler(
			{
				canOfferSessionApproval: false,
				kind: "shell",
				commands: [{ identifier: "node", readOnly: true }],
				fullCommandText: 'node -e "process.exit(0)"',
				intention: "Run an interpreter",
				hasWriteFileRedirection: false,
				possiblePaths: ["/tmp/repo/src/file.ts"],
				possibleUrls: [],
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(denied, {
			kind: "reject",
			feedback:
				"Readonly review mode allows only approved readonly inspection commands.",
		});

		const deniedGitFetch = await permissionHandler(
			{
				canOfferSessionApproval: false,
				kind: "shell",
				commands: [{ identifier: "git", readOnly: true }],
				fullCommandText: "git fetch origin main",
				intention: "Fetch refs",
				hasWriteFileRedirection: false,
				possiblePaths: [],
				possibleUrls: [],
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedGitFetch, {
			kind: "reject",
			feedback:
				"Readonly review mode allows only approved git inspection subcommands.",
		});

		for (const gitSubcommand of ["checkout", "gc"]) {
			const deniedGitMutation = await permissionHandler(
				{
					canOfferSessionApproval: false,
					kind: "shell",
					commands: [{ identifier: "git", readOnly: true }],
					fullCommandText: `git ${gitSubcommand}`,
					intention: "Run git mutation",
					hasWriteFileRedirection: false,
					possiblePaths: [],
					possibleUrls: [],
				} as PermissionRequest,
				{ sessionId: "session-1" },
			);
			assert.deepEqual(deniedGitMutation, {
				kind: "reject",
				feedback:
					"Readonly review mode allows only approved git inspection subcommands.",
			});
		}

		const deniedUrl = await permissionHandler(
			{
				canOfferSessionApproval: false,
				kind: "shell",
				commands: [{ identifier: "git", readOnly: true }],
				fullCommandText: "git diff https://example.com",
				intention: "Inspect a URL-like input",
				hasWriteFileRedirection: false,
				possiblePaths: [],
				possibleUrls: [{ url: "https://example.com" }],
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedUrl, {
			kind: "reject",
			feedback:
				"Readonly review mode blocks shell commands that may access network URLs.",
		});

		const deniedSecretPossiblePath = await permissionHandler(
			{
				canOfferSessionApproval: false,
				kind: "shell",
				commands: [{ identifier: "sed", readOnly: true }],
				fullCommandText: "sed -n '1,80p' config/.env",
				intention: "Inspect source",
				hasWriteFileRedirection: false,
				possiblePaths: ["/tmp/repo/config/.env"],
				possibleUrls: [],
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedSecretPossiblePath, {
			kind: "reject",
			feedback:
				"Readonly review mode blocks shell access to potential secret-bearing path config/.env.",
		});

		const deniedShellExpansion = await permissionHandler(
			{
				canOfferSessionApproval: false,
				kind: "shell",
				commands: [{ identifier: "git", readOnly: true }],
				fullCommandText: "git diff $(git rev-parse HEAD)",
				intention: "Inspect diff with shell expansion",
				hasWriteFileRedirection: false,
				possiblePaths: [],
				possibleUrls: [],
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedShellExpansion, {
			kind: "reject",
			feedback:
				"Readonly review mode blocks shell commands with expansion or pipeline syntax.",
		});

		const deniedEchoWrapper = await permissionHandler(
			{
				canOfferSessionApproval: false,
				kind: "shell",
				commands: [{ identifier: "git", readOnly: true }],
				fullCommandText: "echo 'diff' && git diff --stat",
				intention: "Inspect diff with label",
				hasWriteFileRedirection: false,
				possiblePaths: ["/tmp/repo/src/file.ts"],
				possibleUrls: [],
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedEchoWrapper, {
			kind: "reject",
			feedback:
				"Readonly review mode blocks presentation-only shell wrappers. Run the underlying inspection command directly.",
		});

		const deniedPrintfWrapper = await permissionHandler(
			{
				canOfferSessionApproval: false,
				kind: "shell",
				commands: [{ identifier: "git", readOnly: true }],
				fullCommandText: "git diff --stat && printf '\\n'",
				intention: "Inspect diff with footer",
				hasWriteFileRedirection: false,
				possiblePaths: ["/tmp/repo/src/file.ts"],
				possibleUrls: [],
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedPrintfWrapper, {
			kind: "reject",
			feedback:
				"Readonly review mode blocks presentation-only shell wrappers. Run the underlying inspection command directly.",
		});

		sessionEventHandlers[0]?.({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			ephemeral: true,
			type: "assistant.intent",
			data: {
				intent: "Checking the changed behavior",
			},
		});

		assert.deepEqual(logSpy.infoEntries, [
			{
				message: "Copilot intent",
				details: [
					{
						agentId: undefined,
						intent: "Checking the changed behavior",
					},
				],
			},
		]);
		assert.deepEqual(logSpy.warnEntries, []);
	});
});

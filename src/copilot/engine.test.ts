import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	PermissionRequest,
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
		reviewableFiles: [createChangedFile()],
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

async function recordCleanReview(configArg: SessionConfig): Promise<void> {
	await invokeSessionTool(configArg, "record_pr_summary", {
		summary: "Refactors the reviewed behavior.",
		reviewOutcome: "clean",
	});
}

describe("runCopilotReview", () => {
	it("uses the SDK default bundled CLI resolution", async () => {
		const context = createReviewContext();
		const createdOptions: Array<Record<string, unknown>> = [];
		let createdSessionConfig: SessionConfig | undefined;
		const logSpy = createLoggerSpy();

		const session = {
			on() {
				return () => {};
			},
			async sendAndWait() {
				assert.ok(createdSessionConfig);
				await recordCleanReview(createdSessionConfig);
				return { data: { content: "Looks good." } };
			},
			async disconnect() {},
		};

		const outcome = await runCopilotReview(
			config,
			context,
			{} as never,
			logSpy.logger,
			{
				createCopilotClient(options) {
					createdOptions.push(options as Record<string, unknown>);

					return {
						async start() {},
						async createSession(sessionConfig: SessionConfig) {
							createdSessionConfig = sessionConfig;
							return session as never;
						},
						async stop() {
							return [];
						},
					};
				},
			},
		);

		assert.equal(createdOptions.length, 1);
		assert.equal(createdOptions[0]?.connection, undefined);
		assert.equal(createdOptions[0]?.workingDirectory, config.repoRoot);
		assert.equal(createdOptions[0]?.mode, "copilot-cli");
		assert.equal(outcome.findings.length, 0);
		assert.equal(
			outcome.summary,
			"No validated reportable issues were published from the reviewed pull request changes.",
		);
		assert.equal(outcome.assistantMessage, "Looks good.");
		assert.ok(
			logSpy.infoEntries.some(
				(entry) => entry.message === "Copilot did not emit reasoning events.",
			),
		);
		assert.ok(createdSessionConfig);
		assert.equal(createdSessionConfig.reasoningSummary, "concise");
		assert.deepEqual(
			logSpy.infoEntries.find((entry) =>
				entry.message.startsWith("Copilot review scope prompt"),
			),
			{
				message: "Copilot review scope prompt",
				details: [
					{
						content: [
							"review_scope: changed=1 reviewable=1 +1 -0",
							"reviewable_files:",
							'M +1 -0 "src/example.ts"',
						],
					},
				],
			},
		);

		const infoEntriesBeforePreTool = logSpy.infoEntries.length;
		const preToolOutput = await createdSessionConfig.hooks?.onPreToolUse?.(
			{
				sessionId: "session-1",
				timestamp: new Date(),
				workingDirectory: config.repoRoot,
				toolName: "bash",
				toolArgs: { command: "git diff" },
			},
			{ sessionId: "session-1" },
		);
		assert.equal(preToolOutput, undefined);
		assert.equal(logSpy.infoEntries.length, infoEntriesBeforePreTool);
	});

	it("passes a resolved GitHub token into the created Copilot client", async () => {
		const context = createReviewContext();
		const createdOptions: Array<Record<string, unknown>> = [];
		let createdSessionConfig: SessionConfig | undefined;

		const session = {
			on() {
				return () => {};
			},
			async sendAndWait() {
				assert.ok(createdSessionConfig);
				await recordCleanReview(createdSessionConfig);
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
				resolveGitHubToken: async () => "gho_test-token",
				createCopilotClient(options) {
					createdOptions.push(options as Record<string, unknown>);

					return {
						async start() {},
						async createSession(configArg: SessionConfig) {
							createdSessionConfig = configArg;
							return session as never;
						},
						async stop() {
							return [];
						},
					};
				},
			},
		);

		assert.equal(createdOptions.length, 1);
		assert.equal(createdOptions[0]?.gitHubToken, "gho_test-token");
		assert.equal(createdOptions[0]?.useLoggedInUser, false);
	});

	it("logs accumulated Copilot usage before disconnecting the session", async () => {
		const logSpy = createLoggerSpy();
		const lifecycle: string[] = [];
		const modelMetrics = {
			"gpt-5.3-codex": {
				requests: { count: 2, cost: 0 },
				usage: {
					inputTokens: 1_200,
					outputTokens: 300,
					cacheReadTokens: 800,
					cacheWriteTokens: 100,
					reasoningTokens: 200,
				},
			},
		};

		const outcome = await runCopilotReview(
			config,
			createReviewContext(),
			{} as never,
			logSpy.logger,
			{
				createCopilotClient() {
					return {
						async start() {},
						async createSession(configArg: SessionConfig) {
							return {
								on() {
									return () => {};
								},
								async sendAndWait() {
									await recordCleanReview(configArg);
									return { data: { content: "Looks good." } };
								},
								rpc: {
									usage: {
										async getMetrics() {
											lifecycle.push("usage");
											return {
												totalPremiumRequestCost: 0,
												totalUserRequests: 2,
												totalNanoAiu: 17_996_950_000,
												totalApiDurationMs: 1_000,
												sessionStartTime: "2026-07-14T00:00:00.000Z",
												codeChanges: {
													linesAdded: 0,
													linesRemoved: 0,
													filesModifiedCount: 0,
													filesModified: [],
												},
												modelMetrics,
												lastCallInputTokens: 1_200,
												lastCallOutputTokens: 300,
											};
										},
									},
								},
								async disconnect() {
									lifecycle.push("disconnect");
								},
							} as never;
						},
						async stop() {
							return [];
						},
					};
				},
			},
		);

		assert.deepEqual(lifecycle, ["usage", "disconnect"]);
		assert.deepEqual(outcome.copilotUsage, {
			aiCredits: 17.99695,
			usageValueUsd: 0.1799695,
			modelMetrics,
		});
		assert.deepEqual(
			logSpy.infoEntries.find(
				(entry) => entry.message === "Copilot review usage",
			),
			{
				message: "Copilot review usage",
				details: [
					{
						aiCredits: 17.99695,
						usageValueUsd: 0.1799695,
						modelMetrics,
					},
				],
			},
		);
	});

	it("sends one review request without managed coverage continuation", async () => {
		const context = createReviewContext();
		const logSpy = createLoggerSpy();
		let sendCount = 0;

		const outcome = await runCopilotReview(
			config,
			context,
			{} as never,
			logSpy.logger,
			{
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
												toolName: "bash",
												toolArgs: {},
												toolResult: createSdkToolResult({}),
											} as never,
											{ sessionId: "session-1" } as never,
										);
										await invokeSessionTool(configArg, "record_pr_summary", {
											summary: "Refactors the reviewed behavior.",
											reviewOutcome: "clean",
										});
										await configArg.hooks?.onPostToolUse?.(
											{
												toolName: "record_pr_summary",
												toolArgs: {
													summary: "Refactors the reviewed behavior.",
													reviewOutcome: "clean",
												},
												toolResult: createSdkToolResult({}),
											} as never,
											{ sessionId: "session-1" } as never,
										);
										await configArg.hooks?.onPreToolUse?.(
											{
												toolName: "record_change_area_summary",
												toolArgs: {},
											} as never,
											{ sessionId: "session-1" } as never,
										);
										await configArg.hooks?.onPostToolUseFailure?.(
											{
												toolName: "record_change_area_summary",
												toolArgs: {},
												error: "No reviewed paths matched.",
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
			},
		);

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
		assert.equal(outcome.toolTelemetry?.errorCount, 1);
		assert.equal(
			outcome.toolTelemetry?.byTool.record_change_area_summary?.resultCounts
				.failure,
			1,
		);
	});

	it("rejects missing or inconsistent structured completion outcomes", async () => {
		const context = createReviewContext();
		const logSpy = createLoggerSpy();
		let sendCount = 0;

		for (const reviewOutcome of [undefined, "findings_recorded"] as const) {
			await assert.rejects(
				runCopilotReview(config, context, {} as never, logSpy.logger, {
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
										if (reviewOutcome) {
											await invokeSessionTool(configArg, "record_pr_summary", {
												summary: "Found a build regression.",
												reviewOutcome,
											});
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
				}),
				reviewOutcome
					? /does not match 0 finalized findings/
					: /did not record a structured completion outcome/,
			);
		}

		assert.equal(sendCount, 2);
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

	it("passes system prompt and unfiltered shell permissions into session creation", async () => {
		const context = createReviewContext();
		const createdSessionConfigs: SessionConfig[] = [];
		const sessionEventHandlers: SessionEventHandler[] = [];
		const logSpy = createLoggerSpy();

		await runCopilotReview(config, context, {} as never, logSpy.logger, {
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
								await recordCleanReview(configArg);
								sessionEventHandlers[0]?.({
									id: "reasoning-1",
									timestamp: "2026-03-25T00:00:00.000Z",
									parentId: null,
									type: "assistant.reasoning",
									data: { reasoningId: "r-empty", content: "" },
								});
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
			"custom:record_pr_summary",
			"custom:record_change_area_summary",
			"custom:emit_finding",
		]);
		const permissionHandler = createdSessionConfigs[0]?.onPermissionRequest;
		assert.equal(typeof permissionHandler, "function");
		assert(permissionHandler);
		assert.equal(sessionEventHandlers.length, 1);

		const allowedShell = await permissionHandler(
			{
				canOfferSessionApproval: false,
				kind: "shell",
				commands: [{ identifier: "node", readOnly: false }],
				fullCommandText:
					'node -e "process.exit(0)" > config/.env && curl https://example.com',
				intention: "Use a shell command",
				hasWriteFileRedirection: true,
				possiblePaths: ["/tmp/outside/file.ts", "/tmp/repo/config/.env"],
				possibleUrls: [{ url: "https://example.com" }],
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(allowedShell, { kind: "approve-once" });

		const allowedCustomTool = await permissionHandler(
			{
				kind: "custom-tool",
				toolName: "emit_finding",
				toolDescription: "Record a validated review finding.",
				args: { path: "src/example.ts", line: 1 },
			} satisfies PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(allowedCustomTool, { kind: "approve-once" });

		const deniedUnknownCustomTool = await permissionHandler(
			{
				kind: "custom-tool",
				toolName: "unexpected_tool",
				toolDescription: "An unregistered custom tool.",
			} satisfies PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedUnknownCustomTool, {
			kind: "reject",
			feedback: "Readonly review mode does not allow custom-tool permissions.",
		});

		const deniedRead = await permissionHandler(
			{
				kind: "read",
				intention: "Inspect source",
				path: "/tmp/repo/src/file.ts",
			} satisfies PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedRead, {
			kind: "reject",
			feedback: "Readonly review mode does not allow read permissions.",
		});

		const deniedMcp = await permissionHandler(
			{
				kind: "mcp",
				serverName: "github",
				toolName: "github/search_code",
				toolTitle: "Search code",
				args: { query: "repo:test test" },
				readOnly: true,
			} satisfies PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(deniedMcp, {
			kind: "reject",
			feedback: "Readonly review mode does not allow mcp permissions.",
		});
		assert.deepEqual(logSpy.warnEntries, [
			{
				message: "Copilot permission rejected",
				details: [
					{
						kind: "custom-tool",
						toolName: "unexpected_tool",
						toolCallId: undefined,
						feedback:
							"Readonly review mode does not allow custom-tool permissions.",
					},
				],
			},
			{
				message: "Copilot permission rejected",
				details: [
					{
						kind: "read",
						feedback: "Readonly review mode does not allow read permissions.",
					},
				],
			},
			{
				message: "Copilot permission rejected",
				details: [
					{
						kind: "mcp",
						feedback: "Readonly review mode does not allow mcp permissions.",
					},
				],
			},
		]);

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
				message: "Copilot review scope prompt",
				details: [
					{
						content: [
							"review_scope: changed=1 reviewable=1 +1 -0",
							"reviewable_files:",
							'M +1 -0 "src/example.ts"',
						],
					},
				],
			},
			{
				message: "Copilot emitted reasoning events without content.",
				details: [],
			},
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
	});
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import type {
	PermissionRequest,
	SessionConfig,
	SessionEventHandler,
} from "@github/copilot-sdk";
import type { ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import type { ChangedFile, HunkSummary } from "../git/types.ts";
import type { ReviewContext } from "../review/types.ts";
import type { Logger } from "../shared/logger.ts";
import { runCopilotReview } from "./engine.ts";

const require = createRequire(import.meta.url);

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
		minConfidence: "high",
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

function createGitStub(): GitRepository {
	return {
		diffPaths: async () =>
			"diff --git a/src/example.ts b/src/example.ts\n+const changed = true;",
		listFilesAtCommit: async () => "",
		readTextFileAtCommit: async () => ({ status: "not_found" as const }),
		searchTextAtCommit: async () => "",
	} as unknown as GitRepository;
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

async function recordSuccessfulInspection(
	configArg: SessionConfig,
): Promise<void> {
	let totalPages = 1;
	for (let page = 1; page <= totalPages; page += 1) {
		const toolArgs = { page };
		await configArg.hooks?.onPreToolUse?.(
			{
				toolName: "review_changes",
				toolArgs,
			} as never,
			{ sessionId: "session-1" } as never,
		);
		const result = await invokeSessionTool(
			configArg,
			"review_changes",
			toolArgs,
		);
		if (result && typeof result === "object" && "totalPages" in result) {
			totalPages = Number(result.totalPages);
		}
		await configArg.hooks?.onPostToolUse?.(
			{
				toolName: "review_changes",
				toolArgs,
				toolResult: {
					textResultForLlm: JSON.stringify(result),
					resultType: "success",
				},
			} as never,
			{ sessionId: "session-1" } as never,
		);
	}
}

async function recordCleanSummary(configArg: SessionConfig): Promise<void> {
	await invokeSessionTool(configArg, "record_pr_summary", {
		summary: "Refactors the reviewed behavior.",
		reviewOutcome: "clean",
	});
}

async function recordCleanReview(configArg: SessionConfig): Promise<void> {
	await recordSuccessfulInspection(configArg);
	await recordCleanSummary(configArg);
}

describe("runCopilotReview", () => {
	it("starts the bundled CLI with only structured review tools", async () => {
		const context = createReviewContext();
		const createdOptions: Array<Record<string, unknown>> = [];
		let createdSessionConfig: SessionConfig | undefined;
		const logSpy = createLoggerSpy();

		const session = {
			rpc: {},
			on() {
				return () => {};
			},
			async sendAndWait() {
				assert.ok(createdSessionConfig);
				await recordSuccessfulInspection(createdSessionConfig);
				const searchArgs = {
					revision: "head",
					patterns: ["missing"],
					paths: [],
				};
				await createdSessionConfig.hooks?.onPreToolUse?.(
					{ toolName: "search_repo", toolArgs: searchArgs } as never,
					{ sessionId: "session-1" } as never,
				);
				const searchResult = await invokeSessionTool(
					createdSessionConfig,
					"search_repo",
					searchArgs,
				);
				await createdSessionConfig.hooks?.onPostToolUse?.(
					{
						toolName: "search_repo",
						toolArgs: searchArgs,
						toolResult: createSdkToolResult(
							searchResult as Record<string, unknown>,
						),
					} as never,
					{ sessionId: "session-1" } as never,
				);
				await recordCleanSummary(createdSessionConfig);
				return { data: { content: "Looks good." } };
			},
			async disconnect() {},
		};

		const outcome = await runCopilotReview(
			config,
			context,
			createGitStub(),
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
		const connection = createdOptions[0]?.connection as
			| { kind?: string; path?: string; args?: string[] }
			| undefined;
		assert.equal(connection?.kind, "stdio");
		assert.equal(
			connection?.path,
			require.resolve("@github/copilot/npm-loader.js"),
		);
		assert.equal(connection?.args?.includes("--sandbox"), false);
		assert.equal(connection?.args?.includes("--disallow-temp-dir"), false);
		assert.ok(connection?.args?.includes("--no-custom-instructions"));
		assert.ok(
			connection?.args?.includes("--log-dir=/tmp/repo/.copilot-runtime-logs"),
		);
		assert.equal(createdOptions[0]?.workingDirectory, config.repoRoot);
		assert.equal(createdOptions[0]?.mode, "copilot-cli");
		assert.equal(outcome.findings.length, 0);
		assert.equal(
			outcome.summary,
			"No validated reportable issues were published from the reviewed pull request changes.",
		);
		assert.equal(outcome.assistantMessage, "Looks good.");
		assert.ok(
			(outcome.toolTelemetry?.byTool.review_changes?.resultCharsTotal ?? 0) > 0,
		);
		assert.equal(
			outcome.toolTelemetry?.byTool.review_changes?.coverageComplete,
			true,
		);
		assert.equal(
			outcome.toolTelemetry?.byTool.review_changes?.coverageDeliveredPages,
			1,
		);
		assert.deepEqual(
			{
				uniqueQueries: outcome.toolTelemetry?.byTool.search_repo?.uniqueQueries,
				duplicateQueries:
					outcome.toolTelemetry?.byTool.search_repo?.duplicateQueries,
				wholeRepoQueries:
					outcome.toolTelemetry?.byTool.search_repo?.wholeRepoQueries,
				noMatchQueries:
					outcome.toolTelemetry?.byTool.search_repo?.noMatchQueries,
			},
			{
				uniqueQueries: 1,
				duplicateQueries: 0,
				wholeRepoQueries: 1,
				noMatchQueries: 1,
			},
		);
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

		assert.deepEqual(createdSessionConfig.availableTools, [
			"custom:review_changes",
			"custom:read_file",
			"custom:search_repo",
			"custom:find_files",
			"custom:record_pr_summary",
			"custom:record_change_area_summary",
			"custom:emit_finding",
		]);
		assert.deepEqual(createdSessionConfig.largeOutput, { enabled: false });
	});

	it("passes a resolved GitHub token into the created Copilot client", async () => {
		const context = createReviewContext();
		const createdOptions: Array<Record<string, unknown>> = [];
		let createdSessionConfig: SessionConfig | undefined;

		const session = {
			rpc: {},
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
			createGitStub(),
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
			createGitStub(),
			logSpy.logger,
			{
				createCopilotClient() {
					return {
						async start() {},
						async createSession(configArg: SessionConfig) {
							return {
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
								on() {
									return () => {};
								},
								async sendAndWait() {
									await recordCleanReview(configArg);
									return { data: { content: "Looks good." } };
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
			createGitStub(),
			logSpy.logger,
			{
				createCopilotClient() {
					return {
						async start() {},
						async createSession(configArg: SessionConfig) {
							return {
								rpc: {},
								on() {
									return () => {};
								},
								async sendAndWait() {
									sendCount += 1;
									if (sendCount === 1) {
										await recordSuccessfulInspection(configArg);
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
					"Continuing Copilot review because the structured completion outcome is missing",
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

	it("requests structured completion when the initial review omits it", async () => {
		const context = createReviewContext();
		const logSpy = createLoggerSpy();
		let sendCount = 0;

		const outcome = await runCopilotReview(
			config,
			context,
			createGitStub(),
			logSpy.logger,
			{
				createCopilotClient() {
					return {
						async start() {},
						async createSession(configArg: SessionConfig) {
							return {
								rpc: {},
								on() {
									return () => {};
								},
								async sendAndWait(options: { prompt: string }) {
									sendCount += 1;
									if (sendCount === 1) {
										await recordSuccessfulInspection(configArg);
										await invokeSessionTool(configArg, "emit_finding", {
											path: "src/example.ts",
											line: 100,
											severity: "HIGH",
											type: "BUG",
											confidence: "high",
											title: "Broken behavior",
											details: "The changed line breaks the reviewed behavior.",
										});
									} else {
										assert.match(
											options.prompt,
											/Correct any rejected findings/,
										);
										await invokeSessionTool(configArg, "emit_finding", {
											path: "src/example.ts",
											line: 1,
											severity: "HIGH",
											type: "BUG",
											confidence: "high",
											title: "Broken behavior",
											details: "The changed line breaks the reviewed behavior.",
										});
										await invokeSessionTool(configArg, "record_pr_summary", {
											summary: "Refactors the reviewed behavior.",
											reviewOutcome: "findings_recorded",
										});
									}
									return { data: { content: "Review complete." } };
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

		assert.equal(sendCount, 2);
		assert.equal(outcome.findings.length, 1);
		assert.equal(outcome.prSummary, "Refactors the reviewed behavior.");
	});

	it("rejects missing or inconsistent structured completion outcomes", async () => {
		const context = createReviewContext();
		const logSpy = createLoggerSpy();
		let sendCount = 0;

		for (const reviewOutcome of [undefined, "findings_recorded"] as const) {
			await assert.rejects(
				runCopilotReview(config, context, createGitStub(), logSpy.logger, {
					createCopilotClient() {
						return {
							async start() {},
							async createSession(configArg: SessionConfig) {
								return {
									rpc: {},
									on() {
										return () => {};
									},
									async sendAndWait() {
										sendCount += 1;
										await recordSuccessfulInspection(configArg);
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

		assert.equal(sendCount, 3);
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
				createGitStub(),
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

	it("fails closed when review_changes does not inspect the review diff", async () => {
		await assert.rejects(
			runCopilotReview(
				config,
				createReviewContext(),
				createGitStub(),
				createLoggerSpy().logger,
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
										await recordCleanSummary(configArg);
										return { data: { content: "Looks good." } };
									},
									async disconnect() {},
								} as never;
							},
							async stop() {
								return [];
							},
						};
					},
				},
			),
			/review_changes delivered 0\/1 required pages/,
		);
	});

	it("fails closed after a repository context tool failure", async () => {
		await assert.rejects(
			runCopilotReview(
				config,
				createReviewContext(),
				createGitStub(),
				createLoggerSpy().logger,
				{
					createCopilotClient() {
						return {
							async start() {},
							async createSession(configArg: SessionConfig) {
								let eventHandler: SessionEventHandler | undefined;
								return {
									on(handler: SessionEventHandler) {
										eventHandler = handler;
										return () => {};
									},
									async sendAndWait() {
										const invalidArgs = { page: 0 };
										await configArg.hooks?.onPreToolUse?.(
											{
												toolName: "search_repo",
												toolArgs: invalidArgs,
											} as never,
											{ sessionId: "session-1" } as never,
										);
										eventHandler?.({
											id: "query-start",
											timestamp: "2026-09-02T00:00:00.000Z",
											parentId: null,
											type: "tool.execution_start",
											data: {
												toolCallId: "query-1",
												toolName: "search_repo",
												arguments: invalidArgs,
											},
										} as never);
										eventHandler?.({
											id: "query-complete",
											timestamp: "2026-09-02T00:00:00.100Z",
											parentId: "query-start",
											type: "tool.execution_complete",
											data: {
												toolCallId: "query-1",
												success: false,
												error: { message: "Invalid repository search" },
											},
										} as never);
										await recordCleanReview(configArg);
										return { data: { content: "Looks good." } };
									},
									async disconnect() {},
								} as never;
							},
							async stop() {
								return [];
							},
						};
					},
				},
			),
			/repository context tools failed: search_repo/,
		);
	});

	it("rejects shell permissions and approves registered tools", async () => {
		let createdSessionConfig: SessionConfig | undefined;

		await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub(),
			createLoggerSpy().logger,
			{
				createCopilotClient() {
					return {
						async start() {},
						async createSession(configArg: SessionConfig) {
							createdSessionConfig = configArg;
							return {
								on() {
									return () => {};
								},
								async sendAndWait() {
									await recordCleanReview(configArg);
									return { data: { content: "Looks good." } };
								},
								async disconnect() {},
							} as never;
						},
						async stop() {
							return [];
						},
					};
				},
			},
		);

		assert(createdSessionConfig?.onPermissionRequest);
		const shellDecision = await createdSessionConfig.onPermissionRequest(
			{
				kind: "shell",
				toolCallId: "shell-1",
				commands: [],
				fullCommandText: "git diff",
				intention: "Inspect the diff",
				hasWriteFileRedirection: false,
				possiblePaths: [],
				possibleUrls: [],
				canOfferSessionApproval: false,
			} as PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(shellDecision, {
			kind: "reject",
			feedback:
				"Readonly review mode does not allow shell permissions. Use the structured repository tools for inspection.",
		});

		const toolDecision = await createdSessionConfig.onPermissionRequest(
			{
				kind: "custom-tool",
				toolName: "search_repo",
				toolDescription: "Inspect repository content",
				args: { revision: "head", patterns: ["value"] },
			} satisfies PermissionRequest,
			{ sessionId: "session-1" },
		);
		assert.deepEqual(toolDecision, { kind: "approve-once" });
	});
});

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import type {
	CopilotClientOptions,
	PermissionRequest,
	SessionConfig,
	SessionEvent,
} from "@github/copilot-sdk";
import packageJson from "../../package.json" with { type: "json" };
import type { ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import type { ReviewableFile } from "../git/types.ts";
import type { ReviewContext } from "../review/types.ts";
import type { Logger } from "../shared/logger.ts";
import {
	type RunCopilotReviewDependencies,
	runCopilotReview,
} from "./engine.ts";

const require = createRequire(import.meta.url);

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

type LogEntry = { message: string; details: unknown[] };

function createLoggerSpy(): {
	logger: Logger;
	infoEntries: LogEntry[];
	warnEntries: LogEntry[];
} {
	const infoEntries: LogEntry[] = [];
	const warnEntries: LogEntry[] = [];
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

function createChangedFile(): ReviewableFile {
	return {
		path: "src/example.ts",
		status: "modified",
		changedLines: [1],
		additions: 1,
		deletions: 0,
		isBinary: false,
	};
}

function createReviewContext(): ReviewContext {
	return {
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
		reviewDiff:
			"diff --git a/src/example.ts b/src/example.ts\n+const changed = true;",
		diffStats: { fileCount: 1, additions: 1, deletions: 0 },
		reviewableFiles: [createChangedFile()],
	};
}

function createGitStub(overrides: Partial<GitRepository> = {}): GitRepository {
	return {
		listFilesAtCommit: async () => [],
		readTextFileAtCommit: async () => ({ status: "not_found" as const }),
		searchTextAtCommit: async () => [],
		...overrides,
	} as unknown as GitRepository;
}

type ToolOutcome =
	| { kind: "handler" }
	| { kind: "runtime_failure"; error: string };

type FakeRuntime = {
	readonly sessionConfig: SessionConfig;
	runTool(
		toolName: string,
		args: Record<string, unknown>,
		outcome?: ToolOutcome,
	): Promise<unknown>;
	inspectAllPages(): Promise<void>;
	recordSummary(): Promise<unknown>;
};

type Turn = (runtime: FakeRuntime, prompt: string) => Promise<unknown>;

function createFakeCopilot(
	turns: Turn[],
	options: {
		start?: () => Promise<void>;
		stopErrors?: Error[];
		getMetrics?: () => Promise<unknown>;
	} = {},
) {
	const createdOptions: CopilotClientOptions[] = [];
	const lifecycle: string[] = [];
	let sessionConfig: SessionConfig | undefined;
	let eventHandler: ((event: SessionEvent) => void) | undefined;
	let clockMs = Date.parse("2026-09-11T00:00:00.000Z");
	let callCount = 0;
	let sendCount = 0;

	const emit = (type: SessionEvent["type"], data: Record<string, unknown>) => {
		clockMs += 10;
		eventHandler?.({
			id: `${type}-${clockMs}`,
			timestamp: new Date(clockMs).toISOString(),
			parentId: null,
			type,
			data,
		} as SessionEvent);
	};

	const runtime: FakeRuntime = {
		get sessionConfig() {
			assert.ok(sessionConfig);
			return sessionConfig;
		},
		async runTool(toolName, args, outcome = { kind: "handler" }) {
			const configArg = runtime.sessionConfig;
			const invocation = { sessionId: "session-1" };
			callCount += 1;
			const toolCallId = `${toolName}-${callCount}`;
			emit("tool.execution_start", { toolCallId, toolName, arguments: args });
			await configArg.hooks?.onPreToolUse?.(
				{
					toolName,
					toolArgs: args,
					timestamp: new Date(clockMs),
					sessionId: "session-1",
					workingDirectory: "/tmp/repo",
				},
				invocation,
			);
			const fail = async (error: string) => {
				emit("tool.execution_complete", {
					toolCallId,
					success: false,
					error: { message: error },
				});
				return configArg.hooks?.onPostToolUseFailure?.(
					{
						toolName,
						toolArgs: args,
						error,
						timestamp: new Date(clockMs),
						sessionId: "session-1",
						workingDirectory: "/tmp/repo",
					},
					invocation,
				);
			};
			if (outcome.kind === "runtime_failure") {
				return fail(outcome.error);
			}

			const tool = configArg.tools?.find(
				(candidate) => candidate.name === toolName,
			);
			assert.ok(tool?.handler, `Expected session tool ${toolName}`);
			try {
				const result = await tool.handler(args, {
					sessionId: "session-1",
					toolCallId,
					toolName,
					arguments: args,
				});
				if (
					result &&
					typeof result === "object" &&
					"resultType" in result &&
					result.resultType === "failure" &&
					"textResultForLlm" in result
				) {
					await fail(String(result.textResultForLlm));
				} else {
					emit("tool.execution_complete", {
						toolCallId,
						success: true,
						result: {
							content:
								typeof result === "string" ? result : JSON.stringify(result),
						},
					});
				}
				return result;
			} catch (error) {
				await fail(error instanceof Error ? error.message : String(error));
				return error;
			}
		},
		async inspectAllPages() {
			let totalPages = 1;
			for (let page = 1; page <= totalPages; page += 1) {
				const result = await runtime.runTool("review_changes", { page });
				assert.ok(
					result && typeof result === "object" && "totalPages" in result,
				);
				totalPages = Number(result.totalPages);
			}
		},
		recordSummary() {
			return runtime.runTool("record_pr_summary", {
				summary: "Refactors the reviewed behavior.",
			});
		},
	};

	const session = {
		rpc: {
			usage: {
				async getMetrics() {
					lifecycle.push("usage");
					return options.getMetrics
						? options.getMetrics()
						: { modelMetrics: {} };
				},
			},
		},
		on(handler: (event: SessionEvent) => void) {
			eventHandler = handler;
			return () => {
				eventHandler = undefined;
			};
		},
		async sendAndWait(request: { prompt: string }) {
			const turn = turns[sendCount];
			sendCount += 1;
			const content = await turn?.(runtime, request.prompt);
			return {
				data: {
					content: typeof content === "string" ? content : "Looks good.",
				},
			};
		},
		async disconnect() {
			lifecycle.push("disconnect");
		},
	};

	const dependencies: RunCopilotReviewDependencies = {
		createCopilotClient(clientOptions) {
			createdOptions.push(clientOptions);
			return {
				async start() {
					lifecycle.push("start");
					await options.start?.();
				},
				async createSession(configArg: SessionConfig) {
					sessionConfig = configArg;
					return session as never;
				},
				async stop() {
					lifecycle.push("stop");
					return options.stopErrors ?? [];
				},
			};
		},
	};

	return {
		dependencies,
		runtime,
		createdOptions,
		lifecycle,
		get sendCount() {
			return sendCount;
		},
	};
}

const cleanReview: Turn = async (runtime) => {
	await runtime.inspectAllPages();
	await runtime.recordSummary();
};

describe("runCopilotReview", () => {
	it("starts the bundled CLI with only structured review tools", async () => {
		const logSpy = createLoggerSpy();
		const copilot = createFakeCopilot([
			async (runtime) => {
				await runtime.inspectAllPages();
				await runtime.runTool("search_repo", {
					revision: "head",
					patterns: ["missing"],
					paths: [],
				});
				await runtime.recordSummary();
			},
		]);

		const outcome = await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub(),
			logSpy.logger,
			copilot.dependencies,
		);

		assert.equal(copilot.createdOptions.length, 1);
		const clientOptions = copilot.createdOptions[0];
		const connection = clientOptions?.connection as
			| { kind?: string; path?: string; args?: string[] }
			| undefined;
		assert.equal(connection?.kind, "stdio");
		assert.equal(
			connection?.path,
			require.resolve("@github/copilot/npm-loader.js"),
		);
		assert.equal(connection?.args?.includes("--sandbox"), false);
		assert.ok(connection?.args?.includes("--no-custom-instructions"));
		assert.equal(clientOptions?.mode, "copilot-cli");
		assert.equal(outcome.findings.length, 0);
		assert.equal(
			outcome.summary,
			"No validated reportable issues were published from the reviewed pull request changes.",
		);
		assert.equal(outcome.assistantMessage, "Looks good.");
		const telemetry = outcome.toolTelemetry;
		assert.ok((telemetry?.byTool.review_changes?.resultCharsTotal ?? 0) > 0);
		assert.equal(telemetry?.byTool.review_changes?.coverageComplete, true);
		assert.equal(telemetry?.byTool.review_changes?.coverageDeliveredPages, 1);
		assert.deepEqual(
			{
				requested: telemetry?.totalRequested,
				allowed: telemetry?.totalAllowed,
				completed: telemetry?.totalCompleted,
				errors: telemetry?.errorCount,
			},
			{ requested: 3, allowed: 3, completed: 3, errors: 0 },
		);
		assert.deepEqual(
			{
				uniqueQueries: telemetry?.byTool.search_repo?.uniqueQueries,
				duplicateQueries: telemetry?.byTool.search_repo?.duplicateQueries,
				wholeRepoQueries: telemetry?.byTool.search_repo?.wholeRepoQueries,
				noMatchQueries: telemetry?.byTool.search_repo?.noMatchQueries,
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
		assert.ok(
			logSpy.infoEntries.some((entry) =>
				entry.message.startsWith(
					"Copilot completed tool search_repo result=success duration_ms=",
				),
			),
		);
		const sessionConfig = copilot.runtime.sessionConfig;
		assert.equal(sessionConfig.clientName, packageJson.name);
		assert.equal(sessionConfig.reasoningSummary, "concise");
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
		assert.deepEqual(sessionConfig.availableTools, [
			"custom:review_changes",
			"custom:read_file",
			"custom:search_repo",
			"custom:find_files",
			"custom:record_pr_summary",
			"custom:record_change_area_summary",
			"custom:emit_finding",
		]);
		assert.deepEqual(sessionConfig.largeOutput, { enabled: false });
	});

	it("runs the Copilot runtime in an empty directory outside the repository and removes it afterwards", async () => {
		let runtimeDirectoryEntries: string[] | undefined;
		const copilot = createFakeCopilot([
			async (runtime) => {
				runtimeDirectoryEntries = readdirSync(
					String(runtime.sessionConfig.workingDirectory),
				);
				await runtime.inspectAllPages();
				await runtime.recordSummary();
			},
		]);

		await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub(),
			createLoggerSpy().logger,
			copilot.dependencies,
		);

		const runtimeDirectory = copilot.createdOptions[0]?.workingDirectory;
		assert.ok(runtimeDirectory);
		assert.notEqual(runtimeDirectory, config.repoRoot);
		assert.equal(
			copilot.runtime.sessionConfig.workingDirectory,
			runtimeDirectory,
		);
		assert.deepEqual(runtimeDirectoryEntries, []);
		assert.equal(existsSync(runtimeDirectory), false);
	});

	it("passes a resolved GitHub token into the created Copilot client", async () => {
		const copilot = createFakeCopilot([cleanReview]);

		await runCopilotReview(
			{ ...config, githubHost: "tenant.ghe.com" },
			createReviewContext(),
			createGitStub(),
			createLoggerSpy().logger,
			{
				...copilot.dependencies,
				resolveGitHubToken: async () => "gho_test-token",
			},
		);

		assert.equal(copilot.createdOptions[0]?.gitHubToken, "gho_test-token");
		assert.equal(copilot.createdOptions[0]?.useLoggedInUser, false);
	});

	it("logs accumulated Copilot usage before disconnecting the session", async () => {
		const logSpy = createLoggerSpy();
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
		const copilot = createFakeCopilot([cleanReview], {
			getMetrics: async () => ({
				totalNanoAiu: 17_996_950_000,
				modelMetrics,
			}),
		});

		const outcome = await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub(),
			logSpy.logger,
			copilot.dependencies,
		);

		assert.deepEqual(copilot.lifecycle, [
			"start",
			"usage",
			"disconnect",
			"stop",
		]);
		assert.deepEqual(outcome.copilotUsage, {
			aiCredits: 17.99695,
			usageValueUsd: 0.1799695,
			modelMetrics,
		});
		assert.deepEqual(
			logSpy.infoEntries.find(
				(entry) => entry.message === "Copilot review usage",
			)?.details,
			[{ aiCredits: 17.99695, usageValueUsd: 0.1799695, modelMetrics }],
		);
	});

	it("counts tool failures and client cleanup errors in the telemetry", async () => {
		const logSpy = createLoggerSpy();
		const copilot = createFakeCopilot(
			[
				async (runtime) => {
					await cleanReview(runtime, "");
					await runtime.runTool(
						"record_change_area_summary",
						{},
						{ kind: "runtime_failure", error: "No reviewed paths matched." },
					);
				},
			],
			{ stopErrors: [new Error("runtime exited")] },
		);

		const outcome = await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub(),
			logSpy.logger,
			copilot.dependencies,
		);

		assert.equal(copilot.sendCount, 1);
		assert.equal(outcome.toolTelemetry?.errorCount, 2);
		assert.deepEqual(
			outcome.toolTelemetry?.byTool.record_change_area_summary?.resultCounts,
			{ failure: 1 },
		);
		assert.deepEqual(
			logSpy.warnEntries.map((entry) => entry.message),
			["Copilot client cleanup reported an error"],
		);
	});

	it("requests completion when the initial review omits the summary", async () => {
		const finding = {
			path: "src/example.ts",
			severity: "HIGH",
			type: "BUG",
			confidence: "high",
			title: "Broken behavior",
			details: "The changed line breaks the reviewed behavior.",
		};
		const copilot = createFakeCopilot([
			async (runtime) => {
				await runtime.inspectAllPages();
				await runtime.runTool("emit_finding", { ...finding, line: 100 });
			},
			async (runtime, prompt) => {
				assert.match(prompt, /Correct any rejected findings/);
				await runtime.runTool("emit_finding", { ...finding, line: 1 });
				await runtime.recordSummary();
				return "Review complete.";
			},
		]);

		const outcome = await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub(),
			createLoggerSpy().logger,
			copilot.dependencies,
		);

		assert.equal(copilot.sendCount, 2);
		assert.equal(outcome.findings.length, 1);
		assert.equal(outcome.prSummary, "Refactors the reviewed behavior.");
		assert.equal(outcome.assistantMessage, "Review complete.");
		assert.deepEqual(outcome.toolTelemetry?.byTool.emit_finding?.resultCounts, {
			rejected: 1,
			success: 1,
		});
	});

	it("uses a deterministic fallback when the pull request summary remains missing", async () => {
		const logSpy = createLoggerSpy();
		const copilot = createFakeCopilot([
			async (runtime) => runtime.inspectAllPages(),
		]);

		const outcome = await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub(),
			logSpy.logger,
			copilot.dependencies,
		);

		assert.equal(copilot.sendCount, 2);
		assert.equal(outcome.prSummary, "Test PR");
		assert.equal(outcome.findings.length, 0);
		assert.match(
			logSpy.warnEntries.at(-1)?.message ?? "",
			/using the deterministic pull request summary fallback/,
		);
	});

	it("uses the deterministic fallback when the completion request fails", async () => {
		const logSpy = createLoggerSpy();
		const copilot = createFakeCopilot([
			async (runtime) => runtime.inspectAllPages(),
			async () => {
				throw new Error("completion timeout");
			},
		]);

		const outcome = await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub(),
			logSpy.logger,
			copilot.dependencies,
		);

		assert.equal(copilot.sendCount, 2);
		assert.equal(outcome.prSummary, "Test PR");
		assert.match(
			logSpy.warnEntries.at(-2)?.message ?? "",
			/completion request failed/,
		);
		assert.match(
			logSpy.warnEntries.at(-1)?.message ?? "",
			/using the deterministic pull request summary fallback/,
		);
	});

	it("wraps Copilot startup HTML parse failures with actionable auth guidance", async () => {
		const copilot = createFakeCopilot([], {
			start: async () => {
				throw new SyntaxError(
					"Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
				);
			},
		});

		await assert.rejects(
			runCopilotReview(
				{ ...config, githubHost: "tenant.ghe.com" },
				createReviewContext(),
				createGitStub(),
				createLoggerSpy().logger,
				copilot.dependencies,
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
		assert.deepEqual(copilot.lifecycle, ["start"]);
	});

	it("fails closed when review_changes does not inspect the review diff", async () => {
		const copilot = createFakeCopilot([
			async (runtime) => {
				await runtime.recordSummary();
			},
		]);

		await assert.rejects(
			runCopilotReview(
				config,
				createReviewContext(),
				createGitStub(),
				createLoggerSpy().logger,
				copilot.dependencies,
			),
			/review_changes delivered 0\/1 required pages/,
		);
		assert.deepEqual(copilot.lifecycle, ["start", "disconnect", "stop"]);
	});

	it("returns an incomplete review after an unrecovered context failure", async () => {
		const copilot = createFakeCopilot([
			async (runtime) => {
				await runtime.runTool(
					"search_repo",
					{ revision: "head", patterns: ["value"] },
					{ kind: "runtime_failure", error: "Timed out" },
				);
				await cleanReview(runtime, "");
			},
		]);

		const outcome = await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub(),
			createLoggerSpy().logger,
			copilot.dependencies,
		);

		assert.deepEqual(outcome.incomplete, {
			reason:
				"Repository context inspection was incomplete because these tools had unrecovered failures: search_repo.",
			failedTools: ["search_repo"],
		});
		assert.deepEqual(outcome.findings, []);
		assert.equal(
			outcome.toolTelemetry?.byTool.search_repo?.resultCounts.failure,
			1,
		);
	});

	it("does not treat a rejected context tool result as an execution failure", async () => {
		let rejection: unknown;
		const copilot = createFakeCopilot([
			async (runtime) => {
				rejection = await runtime.runTool("search_repo", {
					revision: "head",
					patterns: ["value"],
					page: 0,
				});
				await cleanReview(runtime, "");
			},
		]);

		const outcome = await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub(),
			createLoggerSpy().logger,
			copilot.dependencies,
		);

		assert.deepEqual(Object.keys(Object(rejection)).sort(), [
			"resultType",
			"textResultForLlm",
		]);
		assert.match(JSON.stringify(rejection), /"Invalid search_repo arguments:/);
		assert.equal(outcome.incomplete, undefined);
		assert.deepEqual(outcome.toolTelemetry?.byTool.search_repo?.resultCounts, {
			rejected: 1,
		});
	});

	it("does not treat SDK input validation as a context failure", async () => {
		let additionalContext: unknown;
		const copilot = createFakeCopilot([
			async (runtime) => {
				additionalContext = await runtime.runTool(
					"read_file",
					{ revision: "head", path: "src/example.ts", ranges: [{ start: 1 }] },
					{
						kind: "runtime_failure",
						error:
							'Invalid input for builtin tool read_file: /ranges/0: "end" is a required property',
					},
				);
				await cleanReview(runtime, "");
			},
		]);

		const outcome = await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub(),
			createLoggerSpy().logger,
			copilot.dependencies,
		);

		assert.equal(outcome.incomplete, undefined);
		assert.deepEqual(outcome.toolTelemetry?.byTool.read_file?.resultCounts, {
			rejected: 1,
		});
		assert.match(
			JSON.stringify(additionalContext),
			/"additionalContext":"Tool read_file rejected invalid input:/,
		);
	});

	it("completes after a repository context tool recovers", async () => {
		let searchCalls = 0;
		const copilot = createFakeCopilot([
			async (runtime) => {
				const query = { revision: "head", patterns: ["value"] };
				await runtime.runTool("search_repo", { ...query, paths: [""] });
				await runtime.runTool("search_repo", {
					...query,
					patternType: "literal",
					paths: [],
					contextLines: 0,
					page: 1,
				});
				await cleanReview(runtime, "");
			},
		]);

		const outcome = await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub({
				searchTextAtCommit: async () => {
					searchCalls += 1;
					if (searchCalls === 1) {
						throw new Error("temporary failure");
					}
					return [];
				},
			}),
			createLoggerSpy().logger,
			copilot.dependencies,
		);

		assert.equal(outcome.incomplete, undefined);
		assert.deepEqual(outcome.toolTelemetry?.byTool.search_repo?.resultCounts, {
			failure: 1,
			success: 1,
		});
	});

	it("rejects shell permissions and approves registered tools", async () => {
		const copilot = createFakeCopilot([cleanReview]);
		await runCopilotReview(
			config,
			createReviewContext(),
			createGitStub(),
			createLoggerSpy().logger,
			copilot.dependencies,
		);
		const { onPermissionRequest } = copilot.runtime.sessionConfig;
		assert.ok(onPermissionRequest);

		assert.deepEqual(
			await onPermissionRequest(
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
			),
			{
				kind: "reject",
				feedback:
					"Readonly review mode does not allow shell permissions. Use the structured repository tools for inspection.",
			},
		);
		assert.deepEqual(
			await onPermissionRequest(
				{
					kind: "custom-tool",
					toolName: "search_repo",
					toolDescription: "Inspect repository content",
					args: { revision: "head", patterns: ["value"] },
				} satisfies PermissionRequest,
				{ sessionId: "session-1" },
			),
			{ kind: "approve-once" },
		);
	});
});

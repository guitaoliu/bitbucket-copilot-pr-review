import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
	CopilotClientOptions,
	CopilotSession,
	PermissionRequest,
	PermissionRequestResult,
	SessionConfig,
	SessionEvent,
	ToolResultObject,
} from "@github/copilot-sdk";
import { CopilotClient, ToolSet } from "@github/copilot-sdk";
import type { ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import { finalizeFindings } from "../policy/findings.ts";
import { finalizeReviewSummary } from "../review/summary.ts";
import type {
	FindingDraft,
	ReviewContext,
	ReviewCopilotUsage,
	ReviewOutcome,
	ReviewSummaryDrafts,
	ReviewToolTelemetry,
	ReviewToolTelemetryCounter,
} from "../review/types.ts";
import type { Logger } from "../shared/logger.ts";
import { omitUndefined } from "../shared/object.ts";
import { truncateText } from "../shared/text.ts";
import { buildPrompt, buildSystemMessage } from "./prompt.ts";
import { createReviewTools, REVIEW_TOOL_NAMES } from "./tools/index.ts";
import { createSessionEventTracer } from "./trace.ts";

const execFileAsync = promisify(execFile);

type ReviewToolName = (typeof REVIEW_TOOL_NAMES)[number];

const BUILTIN_REVIEW_TOOL_NAMES = ["bash"] as const;

type BuiltinReviewToolName = (typeof BUILTIN_REVIEW_TOOL_NAMES)[number];

type PreToolUseInput = {
	toolName: string;
	toolArgs: unknown;
	workingDirectory?: string;
};

type PostToolUseInput = PreToolUseInput & {
	toolResult: ToolResultObject;
};

type PostToolUseFailureInput = PreToolUseInput & {
	error: string;
	sessionId?: string;
	timestamp?: Date;
};

type CopilotClientLike = Pick<
	CopilotClient,
	"start" | "createSession" | "stop"
>;

interface CopilotSessionLike {
	rpc?: {
		usage: Pick<CopilotSession["rpc"]["usage"], "getMetrics">;
	};
	sendAndWait(
		options: Parameters<CopilotSession["sendAndWait"]>[0],
		timeout?: Parameters<CopilotSession["sendAndWait"]>[1],
	): Promise<{ data: { content: string } } | undefined>;
	on(handler: (event: SessionEvent) => void): () => void;
	disconnect(): Promise<void>;
}

type ReviewProgressState = {
	summaryDrafts: ReviewSummaryDrafts;
	toolTelemetry?: ReviewToolTelemetry;
	toolStartedAtMsByName?: Map<string, number[]>;
	droppedFindingCounts?: {
		invalidPayload: number;
		invalidLocation: number;
	};
};

export interface RunCopilotReviewDependencies {
	createCopilotClient?: (options: CopilotClientOptions) => CopilotClientLike;
	resolveGitHubToken?: (
		config: ReviewerConfig,
		logger: Logger,
	) => Promise<string | undefined>;
}

function isReviewToolName(toolName: string): toolName is ReviewToolName {
	return REVIEW_TOOL_NAMES.includes(toolName as ReviewToolName);
}

function isBuiltinReviewToolName(
	toolName: string,
): toolName is BuiltinReviewToolName {
	return BUILTIN_REVIEW_TOOL_NAMES.includes(toolName as BuiltinReviewToolName);
}

function isAllowedReviewToolName(toolName: string): boolean {
	return isReviewToolName(toolName) || isBuiltinReviewToolName(toolName);
}

function buildReviewAvailableTools(): string[] {
	const tools = new ToolSet().addBuiltIn(BUILTIN_REVIEW_TOOL_NAMES);
	for (const toolName of REVIEW_TOOL_NAMES) {
		tools.addCustom(toolName);
	}

	return tools.toArray();
}

type ExecFileAsyncLike = (
	file: string,
	args: readonly string[],
	options: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		encoding?: BufferEncoding;
		maxBuffer?: number;
		windowsHide?: boolean;
	},
) => Promise<{
	stdout: string | Buffer;
	stderr: string | Buffer;
}>;

type ResolvedGitHubToken = {
	token: string;
	source:
		| "COPILOT_GITHUB_TOKEN"
		| "GH_TOKEN"
		| "GITHUB_TOKEN"
		| "gh auth token";
};

const GITHUB_TOKEN_ENV_NAMES = [
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
] as const;

function getGitHubTokenFromEnvironment(
	env: NodeJS.ProcessEnv,
	envNames: readonly (typeof GITHUB_TOKEN_ENV_NAMES)[number][],
): ResolvedGitHubToken | undefined {
	for (const envName of envNames) {
		const rawValue = env[envName];
		if (typeof rawValue !== "string") {
			continue;
		}

		const token = rawValue.trim();
		if (token.length === 0) {
			continue;
		}

		return { token, source: envName };
	}

	return undefined;
}

function normalizeCommandOutput(value: string | Buffer): string | undefined {
	const normalized =
		typeof value === "string" ? value.trim() : value.toString("utf8").trim();
	return normalized.length > 0 ? normalized : undefined;
}

async function resolveCopilotGitHubToken(
	config: ReviewerConfig,
	logger: Logger,
	dependencies: {
		env?: NodeJS.ProcessEnv;
		execFileAsync?: ExecFileAsyncLike;
	} = {},
): Promise<string | undefined> {
	if (config.githubHost === undefined) {
		return undefined;
	}

	const env = dependencies.env ?? process.env;
	const explicitEnvToken = getGitHubTokenFromEnvironment(env, [
		"COPILOT_GITHUB_TOKEN",
	]);
	if (explicitEnvToken) {
		logger.debug("Resolved GitHub token for configured Copilot host", {
			githubHost: config.githubHost,
			source: explicitEnvToken.source,
		});
		return explicitEnvToken.token;
	}

	const runExecFile = dependencies.execFileAsync ?? execFileAsync;
	try {
		const { stdout } = await runExecFile(
			"gh",
			["auth", "token", "--hostname", config.githubHost],
			{
				cwd: config.repoRoot,
				env,
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
				windowsHide: true,
			},
		);
		const token = normalizeCommandOutput(stdout);
		if (token) {
			logger.debug("Resolved GitHub token for configured Copilot host", {
				githubHost: config.githubHost,
				source: "gh auth token",
			});
			return token;
		}
	} catch (error) {
		logger.debug(
			"Unable to resolve GitHub token from GitHub CLI for configured Copilot host",
			{
				githubHost: config.githubHost,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}

	const fallbackEnvToken = getGitHubTokenFromEnvironment(env, [
		"GH_TOKEN",
		"GITHUB_TOKEN",
	]);
	if (fallbackEnvToken) {
		logger.debug("Resolved GitHub token for configured Copilot host", {
			githubHost: config.githubHost,
			source: fallbackEnvToken.source,
		});
		return fallbackEnvToken.token;
	}

	logger.debug(
		"No explicit GitHub token resolved for configured Copilot host; falling back to Copilot CLI login",
		{
			githubHost: config.githubHost,
		},
	);
	return undefined;
}

function buildCopilotClientOptions(
	config: ReviewerConfig,
	gitHubToken?: string,
): CopilotClientOptions {
	const clientLogLevel: CopilotClientOptions["logLevel"] =
		config.logLevel === "debug" ? "debug" : "error";
	const copilotEnvironment =
		config.githubHost !== undefined
			? {
					...process.env,
					COPILOT_GH_HOST: config.githubHost,
					GH_HOST: config.githubHost,
				}
			: undefined;

	return omitUndefined({
		workingDirectory: config.repoRoot,
		mode: "copilot-cli",
		logLevel: clientLogLevel,
		env: copilotEnvironment,
		gitHubToken,
		useLoggedInUser: gitHubToken !== undefined ? false : undefined,
	}) satisfies CopilotClientOptions;
}

function isHtmlJsonParseError(error: Error): boolean {
	return (
		error.message.includes("Unexpected token '<'") ||
		error.message.includes("<!DOCTYPE")
	);
}

function buildCopilotAuthTroubleshootingHint(config: ReviewerConfig): string {
	if (config.githubHost) {
		return `Verify Copilot auth for ${config.githubHost}, and confirm \`gh auth status --hostname ${config.githubHost}\` succeeds or that a valid Copilot token is configured.`;
	}

	return "Verify your Copilot login. If your account uses a GitHub Enterprise Cloud data residency host (`*.ghe.com`), set `GH_HOST` to that hostname before running the reviewer.";
}

function wrapCopilotSessionStageError(
	error: unknown,
	config: ReviewerConfig,
	stage: "client startup" | "session creation" | "review request",
): Error {
	const cause = error instanceof Error ? error : new Error(String(error));
	if (isHtmlJsonParseError(cause)) {
		return new Error(
			`Copilot ${stage} failed because the runtime returned HTML instead of JSON. This usually means Copilot authentication or GitHub host selection is wrong. ${buildCopilotAuthTroubleshootingHint(config)}`,
			{ cause },
		);
	}

	return new Error(`Copilot ${stage} failed: ${cause.message}`, { cause });
}

const MAX_TOOL_LOG_VALUE_LENGTH = 80;

function normalizeToolLogString(value: string): string {
	return truncateText(
		value.replace(/\s+/g, " ").trim(),
		MAX_TOOL_LOG_VALUE_LENGTH,
		{
			suffix: "...",
			preserveMaxLength: true,
		},
	);
}

function formatToolLogValue(value: unknown): string | undefined {
	if (value instanceof Error) {
		return formatToolLogValue(value.message);
	}

	if (typeof value === "string") {
		const normalized = normalizeToolLogString(value);
		if (normalized.length === 0) {
			return undefined;
		}

		return /[\s="]/.test(normalized) ? JSON.stringify(normalized) : normalized;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	return undefined;
}

function getToolArgsRecord(toolArgs: unknown): Record<string, unknown> {
	if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
		return {};
	}

	return toolArgs as Record<string, unknown>;
}

function getToolResultRecord(
	toolResult: ToolResultObject,
): Record<string, unknown> {
	if (
		!toolResult ||
		typeof toolResult !== "object" ||
		Array.isArray(toolResult)
	) {
		return {};
	}

	const rawTextResult = toolResult.textResultForLlm;
	if (typeof rawTextResult === "string" && rawTextResult.length > 0) {
		try {
			const parsed = JSON.parse(rawTextResult);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Non-JSON tool results are expected for string-returning tools.
		}
	}

	return toolResult as Record<string, unknown>;
}

function getDroppedFindingCounts(progressState: ReviewProgressState): {
	invalidPayload: number;
	invalidLocation: number;
} {
	if (progressState.droppedFindingCounts) {
		return progressState.droppedFindingCounts;
	}

	const counts = {
		invalidPayload: 0,
		invalidLocation: 0,
	};
	progressState.droppedFindingCounts = counts;
	return counts;
}

function markDroppedFinding(
	progressState: ReviewProgressState,
	reason: "invalidPayload" | "invalidLocation",
): void {
	getDroppedFindingCounts(progressState)[reason] += 1;
}

function updateRejectedFindingProgress(
	input: PostToolUseInput,
	progressState: ReviewProgressState,
): void {
	if (
		input.toolName !== "emit_finding" ||
		input.toolResult.resultType !== "rejected"
	) {
		return;
	}

	const message =
		typeof input.toolResult.textResultForLlm === "string"
			? input.toolResult.textResultForLlm
			: "";
	if (
		message.startsWith("Line ") ||
		message.startsWith("The file ") ||
		message.includes("not one of the reviewed files") ||
		message.includes("is not a changed line in")
	) {
		markDroppedFinding(progressState, "invalidLocation");
		return;
	}

	if (message.startsWith("Invalid ")) {
		markDroppedFinding(progressState, "invalidPayload");
	}
}

function buildToolLogFields(toolName: string, toolArgs: unknown): string[] {
	const record = getToolArgsRecord(toolArgs);
	const field = (key: string, value: unknown): string | undefined => {
		const formatted = formatToolLogValue(value);
		return formatted ? `${key}=${formatted}` : undefined;
	};

	switch (toolName) {
		case "record_pr_summary":
			return [
				field(
					"summary_chars",
					typeof record.summary === "string"
						? record.summary.length
						: undefined,
				),
			].filter((entry): entry is string => entry !== undefined);
		case "record_change_area_summary":
			return [
				field("title", record.title),
				field(
					"paths",
					Array.isArray(record.paths) ? record.paths.length : undefined,
				),
			].filter((entry): entry is string => entry !== undefined);
		case "emit_finding":
			return [field("path", record.path), field("line", record.line)].filter(
				(entry): entry is string => entry !== undefined,
			);
		default:
			if (toolName === "bash") {
				return [field("command", record.command)].filter(
					(entry): entry is string => entry !== undefined,
				);
			}

			return [];
	}
}

function buildProgressFields(
	config: ReviewerConfig,
	drafts: FindingDraft[],
	progressState: ReviewProgressState,
): string[] {
	return [
		`findings=${drafts.length}/${config.review.maxFindings}`,
		`dropped_findings_invalid_payload=${getDroppedFindingCounts(progressState).invalidPayload}`,
		`dropped_findings_invalid_location=${getDroppedFindingCounts(progressState).invalidLocation}`,
		`pr_summary=${progressState.summaryDrafts.prSummary ? "recorded" : "missing"}`,
	];
}

function buildReadonlyPermissionDecision(
	request: PermissionRequest,
): PermissionRequestResult {
	return request.kind === "shell" ||
		(request.kind === "custom-tool" && isReviewToolName(request.toolName))
		? { kind: "approve-once" }
		: {
				kind: "reject",
				feedback: `Readonly review mode does not allow ${request.kind} permissions.`,
			};
}

function getToolResultDurationMs(
	toolResult: ToolResultObject,
): number | undefined {
	const record = getToolResultRecord(toolResult);
	const telemetry = record.toolTelemetry;
	if (
		telemetry &&
		typeof telemetry === "object" &&
		!Array.isArray(telemetry) &&
		typeof (telemetry as { durationMs?: unknown }).durationMs === "number"
	) {
		return (telemetry as { durationMs: number }).durationMs;
	}

	if (telemetry && typeof telemetry === "object" && !Array.isArray(telemetry)) {
		for (const value of Object.values(telemetry)) {
			if (
				value &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				typeof (value as { durationMs?: unknown }).durationMs === "number"
			) {
				return (value as { durationMs: number }).durationMs;
			}
		}
	}

	return undefined;
}
function shiftToolStartTime(
	progressState: ReviewProgressState,
	toolName: string,
): number | undefined {
	const pendingStarts = progressState.toolStartedAtMsByName?.get(toolName);
	if (!pendingStarts || pendingStarts.length === 0) {
		return undefined;
	}

	const startedAt = pendingStarts.shift();
	if (pendingStarts.length === 0) {
		progressState.toolStartedAtMsByName?.delete(toolName);
	}

	return startedAt;
}

function createEmptyToolTelemetryCounter(): ReviewToolTelemetryCounter {
	return {
		requested: 0,
		allowed: 0,
		denied: 0,
		completed: 0,
		resultCounts: {},
		totalDurationMs: 0,
	};
}

function createEmptyReviewToolTelemetry(): ReviewToolTelemetry {
	return {
		totalRequested: 0,
		totalAllowed: 0,
		totalDenied: 0,
		totalCompleted: 0,
		totalDurationMs: 0,
		sessionDurationMs: 0,
		errorCount: 0,
		byTool: {},
	};
}

function getToolTelemetryCounter(
	toolTelemetry: ReviewToolTelemetry,
	toolName: string,
): ReviewToolTelemetryCounter {
	const existing = toolTelemetry.byTool[toolName];
	if (existing) {
		return existing;
	}

	const created = createEmptyToolTelemetryCounter();
	toolTelemetry.byTool[toolName] = created;
	return created;
}

function buildPreToolLogMessage(input: PreToolUseInput): string {
	return [
		"Copilot requested tool",
		input.toolName,
		...buildToolLogFields(input.toolName, input.toolArgs),
	].join(" ");
}

function buildPostToolLogMessage(
	input: PostToolUseInput,
	config: ReviewerConfig,
	drafts: FindingDraft[],
	progressState: ReviewProgressState,
): string {
	return [
		"Copilot completed tool",
		input.toolName,
		`result=${input.toolResult.resultType}`,
		formatToolLogValue(getToolResultDurationMs(input.toolResult))
			? `duration_ms=${formatToolLogValue(getToolResultDurationMs(input.toolResult))}`
			: undefined,
		formatToolLogValue(input.toolResult.error)
			? `error=${formatToolLogValue(input.toolResult.error)}`
			: undefined,
		...buildToolLogFields(input.toolName, input.toolArgs),
		...buildProgressFields(config, drafts, progressState),
	]
		.filter((entry): entry is string => entry !== undefined)
		.join(" ");
}

function buildPostToolFailureLogMessage(
	input: PostToolUseFailureInput,
): string {
	return [
		`Copilot failed tool ${input.toolName}`,
		formatToolLogValue(input.error)
			? `error=${formatToolLogValue(input.error)}`
			: undefined,
		...buildToolLogFields(input.toolName, input.toolArgs),
	]
		.filter((entry): entry is string => entry !== undefined)
		.join(" ");
}

function createReviewSessionHooks(
	config: ReviewerConfig,
	logger: Logger,
	drafts: FindingDraft[],
	progressState: ReviewProgressState = {
		summaryDrafts: {},
		toolTelemetry: createEmptyReviewToolTelemetry(),
		toolStartedAtMsByName: new Map(),
	},
) {
	return {
		onPreToolUse: async (input: PreToolUseInput) => {
			const toolTelemetry =
				progressState.toolTelemetry ?? createEmptyReviewToolTelemetry();
			progressState.toolTelemetry = toolTelemetry;
			toolTelemetry.totalRequested += 1;
			getToolTelemetryCounter(toolTelemetry, input.toolName).requested += 1;

			if (input.toolName !== "bash") {
				logger.info(buildPreToolLogMessage(input));
			}
			if (!isAllowedReviewToolName(input.toolName)) {
				return;
			}

			toolTelemetry.totalAllowed += 1;
			const counter = getToolTelemetryCounter(toolTelemetry, input.toolName);
			counter.allowed += 1;
			const pendingStarts =
				progressState.toolStartedAtMsByName ?? new Map<string, number[]>();
			progressState.toolStartedAtMsByName = pendingStarts;
			pendingStarts.set(input.toolName, [
				...(pendingStarts.get(input.toolName) ?? []),
				Date.now(),
			]);
		},
		onPostToolUse: async (input: PostToolUseInput) => {
			const toolTelemetry =
				progressState.toolTelemetry ?? createEmptyReviewToolTelemetry();
			progressState.toolTelemetry = toolTelemetry;
			toolTelemetry.totalCompleted += 1;
			const counter = getToolTelemetryCounter(toolTelemetry, input.toolName);
			counter.completed += 1;
			const durationMs =
				getToolResultDurationMs(input.toolResult) ??
				(() => {
					const startedAt = shiftToolStartTime(progressState, input.toolName);
					return startedAt !== undefined ? Date.now() - startedAt : 0;
				})();
			counter.totalDurationMs += durationMs;
			toolTelemetry.totalDurationMs += durationMs;
			const resultType = input.toolResult.resultType;
			counter.resultCounts[resultType] =
				(counter.resultCounts[resultType] ?? 0) + 1;
			updateRejectedFindingProgress(input, progressState);

			if (input.toolName !== "bash") {
				logger.info(
					buildPostToolLogMessage(input, config, drafts, progressState),
				);
			}
		},
		onPostToolUseFailure: async (input: PostToolUseFailureInput) => {
			if (input.toolName !== "bash") {
				logger.info(buildPostToolFailureLogMessage(input));
			}
			return {
				additionalContext: `Tool ${input.toolName} failed: ${input.error}. Use the failure to adjust inputs and continue the readonly review.`,
			};
		},
		onErrorOccurred: async (input: {
			errorContext: string;
			error: unknown;
		}) => {
			const toolTelemetry =
				progressState.toolTelemetry ?? createEmptyReviewToolTelemetry();
			progressState.toolTelemetry = toolTelemetry;
			toolTelemetry.errorCount += 1;
			logger.warn(
				`Copilot session reported an error in ${input.errorContext}`,
				input.error,
			);
			return { errorHandling: "abort" as const };
		},
	};
}

function summarizeOutcome(
	context: ReviewContext,
	findingsCount: number,
): string {
	if (context.reviewableFiles.length === 0) {
		return "No reviewable files remained after exclusions, so no AI review was performed.";
	}

	if (findingsCount === 0) {
		return "No validated reportable issues were published from the reviewed pull request changes.";
	}

	return `Copilot identified ${findingsCount} reportable issue${findingsCount === 1 ? "" : "s"} in the reviewed pull request changes.`;
}

export async function runCopilotReview(
	config: ReviewerConfig,
	context: ReviewContext,
	git: GitRepository,
	logger: Logger,
	dependencies: RunCopilotReviewDependencies = {},
): Promise<ReviewOutcome> {
	if (context.reviewableFiles.length === 0) {
		return {
			summary: summarizeOutcome(context, 0),
			findings: [],
			stale: false,
		};
	}

	const drafts: FindingDraft[] = [];
	const summaryDrafts: ReviewSummaryDrafts = {};
	const toolTelemetry = createEmptyReviewToolTelemetry();
	const progressState: ReviewProgressState = {
		summaryDrafts,
		toolTelemetry,
	};
	const reviewStartedAt = Date.now();
	const gitHubToken = await (dependencies.resolveGitHubToken?.(
		config,
		logger,
	) ?? resolveCopilotGitHubToken(config, logger));
	const clientOptions = buildCopilotClientOptions(config, gitHubToken);
	const sessionEventTracer = createSessionEventTracer(logger);

	const client =
		dependencies.createCopilotClient?.(clientOptions) ??
		new CopilotClient(clientOptions);
	let clientStarted = false;
	let session: CopilotSessionLike | undefined;
	let unsubscribeSessionEvents = (): void => {};
	const sessionConfig = {
		clientName: "bitbucket-copilot-pr-review",
		model: config.copilot.model,
		reasoningEffort: config.copilot.reasoningEffort,
		reasoningSummary: "concise",
		systemMessage: buildSystemMessage(config),
		streaming: true,
		tools: createReviewTools(context, git, drafts, summaryDrafts),
		availableTools: buildReviewAvailableTools(),
		onPermissionRequest: (request: PermissionRequest) => {
			const decision = buildReadonlyPermissionDecision(request);
			if (decision.kind === "reject") {
				logger.warn("Copilot permission rejected", {
					kind: request.kind,
					...(request.kind === "custom-tool"
						? {
								toolName: request.toolName,
								toolCallId: request.toolCallId,
							}
						: {}),
					feedback: decision.feedback,
				});
			}
			return decision;
		},
		hooks: createReviewSessionHooks(config, logger, drafts, progressState),
		workingDirectory: config.repoRoot,
		includeSubAgentStreamingEvents: true,
		infiniteSessions: { enabled: false },
	} satisfies SessionConfig;

	try {
		try {
			await client.start();
			clientStarted = true;
		} catch (error) {
			throw wrapCopilotSessionStageError(error, config, "client startup");
		}

		try {
			session = await client.createSession(sessionConfig);
		} catch (error) {
			throw wrapCopilotSessionStageError(error, config, "session creation");
		}

		unsubscribeSessionEvents = session.on((event) => {
			sessionEventTracer.handleEvent(event);
		});

		let response: Awaited<ReturnType<CopilotSessionLike["sendAndWait"]>>;
		try {
			response = await session.sendAndWait(
				{ prompt: buildPrompt(context, config.review.ignorePaths) },
				config.copilot.timeoutMs,
			);
		} catch (error) {
			throw wrapCopilotSessionStageError(error, config, "review request");
		}
		const reasoningStatus = sessionEventTracer.getReasoningStatus();
		if (reasoningStatus !== "content") {
			logger.info(
				reasoningStatus === "empty"
					? "Copilot emitted reasoning events without content."
					: "Copilot did not emit reasoning events.",
			);
		}
		const findings = finalizeFindings(
			drafts,
			context.reviewableFiles,
			config.review.maxFindings,
			config.review.minConfidence,
		);
		const reviewSummary = finalizeReviewSummary(context, summaryDrafts);
		const assistantMessage = response?.data.content;
		toolTelemetry.sessionDurationMs = Date.now() - reviewStartedAt;
		let copilotUsage: ReviewCopilotUsage | undefined;
		if (session.rpc?.usage) {
			try {
				const usage = await session.rpc.usage.getMetrics();
				copilotUsage = omitUndefined({
					aiCredits:
						usage.totalNanoAiu === undefined
							? undefined
							: usage.totalNanoAiu / 1_000_000_000,
					usageValueUsd:
						usage.totalNanoAiu === undefined
							? undefined
							: usage.totalNanoAiu / 100_000_000_000,
					modelMetrics: usage.modelMetrics,
				});
				logger.info("Copilot review usage", copilotUsage);
			} catch (error) {
				logger.warn("Failed to read Copilot review usage", error);
			}
		}

		return omitUndefined({
			summary: summarizeOutcome(context, findings.length),
			findings,
			assistantMessage,
			prSummary: reviewSummary.prSummary,
			changeAreas: reviewSummary.changeAreas,
			toolTelemetry,
			copilotUsage,
			stale: false,
		}) satisfies ReviewOutcome;
	} finally {
		unsubscribeSessionEvents();
		if (session && typeof session.disconnect === "function") {
			await session.disconnect();
		}
		if (clientStarted) {
			const errors = await client.stop();
			toolTelemetry.errorCount += errors.length;
			for (const error of errors) {
				logger.warn("Copilot client cleanup reported an error", error);
			}
		}
	}
}

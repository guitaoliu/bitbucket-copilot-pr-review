import type {
	CopilotClientOptions,
	PermissionRequest,
	SessionConfig,
} from "@github/copilot-sdk";
import { CopilotClient, ToolSet } from "@github/copilot-sdk";
import type { ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import { finalizeFindings } from "../policy/findings.ts";
import type { ReviewFinding } from "../policy/types.ts";
import { finalizeReviewSummary } from "../review/summary.ts";
import type {
	ReviewCopilotUsage,
	ReviewOutcome,
	ReviewScope,
} from "../review/types.ts";
import type { Logger } from "../shared/logger.ts";
import { omitUndefined } from "../shared/object.ts";
import { resolveCopilotGitHubToken } from "./auth.ts";
import {
	buildPrompt,
	buildReviewScopeLines,
	buildSystemMessage,
} from "./prompt.ts";
import { ReviewBundle } from "./review-bundle.ts";
import {
	buildCopilotClientOptions,
	COPILOT_APPLICATION_NAME,
	type CopilotClientLike,
	type CopilotReply,
	type CopilotSessionLike,
	withCopilotSession,
	withRuntimeDirectory,
	wrapCopilotStageError,
} from "./runtime.ts";
import {
	createReviewToolTelemetryTracker,
	isSdkToolInputValidationError,
	type ReviewToolTelemetryTracker,
} from "./telemetry.ts";
import {
	buildToolCompletionLog,
	buildToolRequestLogMessage,
} from "./tool-log.ts";
import {
	createReviewToolState,
	type ReviewToolState,
} from "./tools/context.ts";
import { createReviewTools, REVIEW_TOOL_NAMES } from "./tools/index.ts";
import { createSessionEventTracer } from "./trace.ts";

export interface RunCopilotReviewDependencies {
	createCopilotClient?: (options: CopilotClientOptions) => CopilotClientLike;
	resolveGitHubToken?: (
		config: ReviewerConfig,
		logger: Logger,
	) => Promise<string | undefined>;
}

interface ReviewConversation {
	config: ReviewerConfig;
	context: ReviewScope;
	logger: Logger;
	reviewBundle: ReviewBundle;
	toolState: ReviewToolState;
	tracker: ReviewToolTelemetryTracker;
}

const COMPLETION_PROMPT =
	"Finish the review without more repository inspection. Correct any rejected findings using the tool feedback, emit any remaining already-validated findings, then call record_pr_summary.";

function buildSessionConfig(
	conversation: ReviewConversation,
	git: GitRepository,
	runtimeDirectory: string,
): SessionConfig {
	const { config, context, logger, reviewBundle, toolState, tracker } =
		conversation;
	const availableTools = new ToolSet();
	for (const toolName of REVIEW_TOOL_NAMES) {
		availableTools.addCustom(toolName);
	}

	return {
		clientName: COPILOT_APPLICATION_NAME,
		model: config.copilot.model,
		reasoningEffort: config.copilot.reasoningEffort,
		reasoningSummary: "concise",
		enableExperimentalMode: true,
		systemMessage: buildSystemMessage(config),
		streaming: true,
		enableFileHooks: false,
		enableHostGitOperations: false,
		enableSessionStore: false,
		memory: { enabled: false },
		largeOutput: { enabled: false },
		tools: createReviewTools({
			context,
			git,
			logger,
			reviewBundle,
			state: toolState,
			toolCalls: tracker,
		}),
		availableTools: availableTools.toArray(),
		onPermissionRequest: (request: PermissionRequest) => {
			if (
				request.kind === "custom-tool" &&
				(REVIEW_TOOL_NAMES as readonly string[]).includes(request.toolName)
			) {
				return { kind: "approve-once" as const };
			}

			const feedback = `Readonly review mode does not allow ${request.kind} permissions. Use the structured repository tools for inspection.`;
			tracker.recordPermissionDenied(request);
			logger.warn("Copilot permission rejected", {
				kind: request.kind,
				...(request.kind === "custom-tool"
					? { toolName: request.toolName, toolCallId: request.toolCallId }
					: {}),
				feedback,
			});
			return { kind: "reject" as const, feedback };
		},
		hooks: {
			onPreToolUse: async (input) => {
				logger.info(buildToolRequestLogMessage(input.toolName, input.toolArgs));
			},
			onPostToolUseFailure: async (input) => ({
				additionalContext: isSdkToolInputValidationError(input.error)
					? `Tool ${input.toolName} rejected invalid input: ${input.error}. Correct the arguments and continue the readonly review.`
					: `Tool ${input.toolName} failed: ${input.error}. Use the failure to adjust inputs and continue the readonly review.`,
			}),
			onErrorOccurred: async (input) => {
				tracker.recordError();
				logger.warn(
					`Copilot session reported an error in ${input.errorContext}`,
					input.error,
				);
				return { errorHandling: "abort" as const };
			},
		},
		workingDirectory: runtimeDirectory,
		skipCustomInstructions: true,
		includeSubAgentStreamingEvents: true,
		infiniteSessions: { enabled: false },
	};
}

async function readCopilotUsage(
	session: CopilotSessionLike,
	logger: Logger,
): Promise<ReviewCopilotUsage | undefined> {
	try {
		const usage = await session.rpc.usage.getMetrics();
		const copilotUsage = omitUndefined({
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
		return copilotUsage;
	} catch (error) {
		logger.warn("Failed to read Copilot review usage", error);
		return undefined;
	}
}

async function converse(
	session: CopilotSessionLike,
	conversation: ReviewConversation,
): Promise<{ assistantMessage?: string; copilotUsage?: ReviewCopilotUsage }> {
	const { config, context, logger, reviewBundle, toolState, tracker } =
		conversation;
	const tracer = createSessionEventTracer(logger);
	const unsubscribe = session.on((event) => {
		const completedCall = tracker.handleEvent(event);
		if (completedCall) {
			const log = buildToolCompletionLog(completedCall, toolState);
			if (log.details) {
				logger.info(log.message, log.details);
			} else {
				logger.info(log.message);
			}
		}
		tracer.handleEvent(event);
	});

	try {
		logger.info("Copilot review scope prompt", {
			content: buildReviewScopeLines(context),
		});
		let response: CopilotReply;
		try {
			response = await session.sendAndWait(
				{ prompt: buildPrompt(context, config.review.ignorePaths) },
				config.copilot.timeoutMs,
			);
		} catch (error) {
			throw wrapCopilotStageError(error, config, "review request");
		}

		const coverage = reviewBundle.getCoverage();
		if (!coverage.complete) {
			throw new Error(
				`Copilot review stopped because review_changes delivered ${coverage.deliveredPages}/${coverage.totalPages ?? "?"} required pages.`,
			);
		}
		const reasoningStatus = tracer.getReasoningStatus();
		if (reasoningStatus !== "content") {
			logger.info(
				reasoningStatus === "empty"
					? "Copilot emitted reasoning events without content."
					: "Copilot did not emit reasoning events.",
			);
		}

		if (!toolState.summaryDrafts.prSummary) {
			logger.info(
				"Continuing Copilot review because the pull request summary is missing.",
				{ findings: toolState.drafts.length },
			);
			tracker.recordCompletionFollowUp();
			try {
				response = await session.sendAndWait(
					{ prompt: COMPLETION_PROMPT },
					config.copilot.timeoutMs,
				);
			} catch (error) {
				logger.warn(
					"Copilot review completion request failed; continuing with finalized findings and the deterministic summary fallback if needed.",
					error,
				);
			}
		}

		return omitUndefined({
			assistantMessage: response?.data.content,
			copilotUsage: await readCopilotUsage(session, logger),
		});
	} finally {
		unsubscribe();
	}
}

function summarizeOutcome(context: ReviewScope, findingsCount: number): string {
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
	context: ReviewScope,
	git: GitRepository,
	logger: Logger,
	dependencies: RunCopilotReviewDependencies = {},
): Promise<ReviewOutcome> {
	if (context.reviewableFiles.length === 0) {
		return {
			summary: summarizeOutcome(context, 0),
			findings: [],
		};
	}

	const conversation: ReviewConversation = {
		config,
		context,
		logger,
		reviewBundle: new ReviewBundle(context, git),
		toolState: createReviewToolState(),
		tracker: createReviewToolTelemetryTracker(),
	};
	const { toolState, tracker } = conversation;
	const reviewStartedAt = Date.now();
	const gitHubToken = await (
		dependencies.resolveGitHubToken ?? resolveCopilotGitHubToken
	)(config, logger);
	const { assistantMessage, copilotUsage } = await withRuntimeDirectory(
		config,
		logger,
		(runtimeDirectory) => {
			const clientOptions = buildCopilotClientOptions(
				config,
				gitHubToken,
				runtimeDirectory,
			);
			return withCopilotSession(
				{
					config,
					logger,
					client:
						dependencies.createCopilotClient?.(clientOptions) ??
						new CopilotClient(clientOptions),
					sessionConfig: buildSessionConfig(
						conversation,
						git,
						runtimeDirectory,
					),
					onCleanupError: () => tracker.recordError(),
				},
				(session) => converse(session, conversation),
			);
		},
	);
	const toolTelemetry = tracker.snapshot({
		sessionDurationMs: Date.now() - reviewStartedAt,
		inspection: toolState.inspection,
		coverage: conversation.reviewBundle.getCoverage(),
	});

	const failedTools = tracker.getUnresolvedContextTools();
	if (failedTools.length > 0) {
		const reason = `Repository context inspection was incomplete because these tools had unrecovered failures: ${failedTools.join(", ")}.`;
		logger.warn(reason);
		return omitUndefined({
			summary: reason,
			findings: [] as ReviewFinding[],
			incomplete: { reason, failedTools },
			assistantMessage,
			toolTelemetry,
			copilotUsage,
		}) satisfies ReviewOutcome;
	}

	const findings = finalizeFindings(
		toolState.drafts,
		config.review.minConfidence,
	);
	const reviewSummary = finalizeReviewSummary(context, toolState.summaryDrafts);
	if (!toolState.summaryDrafts.prSummary) {
		logger.warn(
			"Copilot review summary was still missing after the completion request; using the deterministic pull request summary fallback.",
		);
	}

	return omitUndefined({
		summary: summarizeOutcome(context, findings.length),
		findings,
		assistantMessage,
		prSummary: reviewSummary.prSummary,
		changeAreas: reviewSummary.changeAreas,
		toolTelemetry,
		copilotUsage,
	}) satisfies ReviewOutcome;
}

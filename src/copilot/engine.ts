import type {
	CopilotClientOptions,
	CopilotSession,
	ToolResultObject,
} from "@github/copilot-sdk";
import { approveAll, CopilotClient } from "@github/copilot-sdk";
import type { ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import { finalizeFindings } from "../policy/findings.ts";
import {
	finalizeReviewSummary,
	MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES,
	shouldCreatePerFileSummaries,
} from "../review/summary.ts";
import type {
	FindingDraft,
	ReviewContext,
	ReviewOutcome,
	ReviewSummaryDrafts,
	ReviewToolTelemetry,
	ReviewToolTelemetryCounter,
} from "../review/types.ts";
import type { Logger } from "../shared/logger.ts";
import { omitUndefined } from "../shared/object.ts";
import { truncateText } from "../shared/text.ts";
import { resolveBundledCopilotCliPath } from "./cli-path.ts";
import { buildPrompt } from "./prompt.ts";
import {
	FINDING_TAXONOMY_HINT,
	QUESTION_SHAPED_FINDING_HINT,
	TEST_COVERAGE_HINT,
} from "./review-guidance.ts";
import { createReviewTools, REVIEW_TOOL_NAMES } from "./tools/index.ts";
import { wireReasoningTrace } from "./trace.ts";

type ReviewToolName = (typeof REVIEW_TOOL_NAMES)[number];

type PreToolUseInput = {
	toolName: string;
	toolArgs: unknown;
	cwd: string;
};

type PostToolUseInput = PreToolUseInput & {
	toolResult: ToolResultObject;
};

type CopilotClientLike = Pick<
	CopilotClient,
	"start" | "createSession" | "stop"
>;

export interface CopilotSessionLike {
	on: CopilotSession["on"];
	sendAndWait(
		options: Parameters<CopilotSession["sendAndWait"]>[0],
		timeout?: Parameters<CopilotSession["sendAndWait"]>[1],
	): Promise<{ data: { content: string } } | undefined>;
	disconnect(): Promise<void>;
}

type ReviewProgressState = {
	reviewedFileCount: number;
	summaryDrafts: ReviewSummaryDrafts;
	toolTelemetry?: ReviewToolTelemetry;
};

export interface RunCopilotReviewDependencies {
	resolveCliPath?: () => string;
	createCopilotClient?: (options: CopilotClientOptions) => CopilotClientLike;
	createReviewSession?: (input: {
		client: CopilotClientLike;
		config: ReviewerConfig;
		context: ReviewContext;
		git: GitRepository;
		logger: Logger;
		drafts: FindingDraft[];
		summaryDrafts: ReviewSummaryDrafts;
	}) => Promise<CopilotSessionLike>;
}

function isReviewToolName(toolName: string): toolName is ReviewToolName {
	return REVIEW_TOOL_NAMES.includes(toolName as ReviewToolName);
}

function buildSessionHint(
	config: ReviewerConfig,
	reviewedFileCount: number,
): string {
	const perFileSummariesEnabled =
		shouldCreatePerFileSummaries(reviewedFileCount);

	return [
		"Review all material issues introduced by this pull request.",
		"Inspect diff plus relevant head/base code before emitting any finding.",
		TEST_COVERAGE_HINT,
		"Ignore style, naming, formatting, and preference-only feedback.",
		FINDING_TAXONOMY_HINT,
		QUESTION_SHAPED_FINDING_HINT,
		...(perFileSummariesEnabled
			? []
			: [
					`Per-file summaries are disabled for large reviews with more than ${MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES} reviewed files; keep the PR summary current and continue reviewing without file summaries.`,
				]),
		"Cover the reviewed risk areas and continue after the first finding when more distinct issues may exist.",
		`Keep findings distinct, evidence-backed, and limited to ${config.review.minConfidence} confidence or better, up to ${config.review.maxFindings} total.`,
	].join(" ");
}

function buildPreToolHint(
	toolName: ReviewToolName,
	reviewedFileCount: number,
): string {
	const perFileSummariesEnabled =
		shouldCreatePerFileSummaries(reviewedFileCount);

	switch (toolName) {
		case "get_pr_overview":
			return "Use the overview to scope the review, find the highest-risk files, and avoid redundant file-list or CI calls unless you need more detail.";
		case "list_changed_files":
			return "Use this only when you need a refreshed file list or skipped-file details beyond get_pr_overview; then start with the riskiest reviewed files and continue until meaningful reviewed changes are covered.";
		case "get_file_diff":
			return "Study the exact changed lines and look for removed guards, altered control flow, or contract shifts.";
		case "get_file_diff_hunk":
			return "Use hunk paging to inspect a large diff without broadening scope beyond the file under review.";
		case "get_file_content":
			return "Read head and base content as needed to verify a concrete regression, broken invariant, or API change.";
		case "get_file_list_by_directory":
			return "Use directory listing to orient around nearby code, but keep the review anchored to PR-introduced behavior.";
		case "get_related_file_content":
			return "Read nearby files to confirm concrete hypotheses about impact, invariants, call paths, or additional affected paths.";
		case "get_related_tests":
			return "Use this to find likely nearby automated tests for a reviewed file before resorting to broader repository search.";
		case "search_text_in_repo":
		case "search_symbol_name":
			return "Search narrowly to validate suspected code paths, impacted call sites, or nearby tests. Avoid broad repo fishing expeditions and wildcard-like directory guesses.";
		case "get_ci_summary":
			return "Treat CI output as a prioritization hint, not proof of a reportable issue.";
		case "record_pr_summary":
			return perFileSummariesEnabled
				? "Capture the PR's intended behavior change in one concise, evidence-backed summary once you understand the diff."
				: `Capture the PR's intended behavior change in one concise, evidence-backed summary once you understand the diff. Per-file summaries are disabled for reviews with more than ${MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES} reviewed files.`;
		case "record_file_summary":
			return perFileSummariesEnabled
				? "Record a short, concrete summary of what changed in a reviewed file once you have enough context to describe it accurately."
				: `Per-file summaries are disabled for reviews with more than ${MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES} reviewed files; do not use this tool.`;
		case "list_recorded_findings":
			return "Check recorded findings before adding more to avoid duplicates and confirm whether important reviewed areas still lack coverage.";
		case "remove_recorded_finding":
			return "Remove a recorded finding only when it is duplicate, superseded, or too weak to keep in the final set.";
		case "replace_recorded_finding":
			return "Replace a recorded finding only when the new draft is clearly stronger, more accurate, or better located.";
		case "emit_finding":
			return `Only emit a finding after verifying the issue from inspected code. ${FINDING_TAXONOMY_HINT} ${QUESTION_SHAPED_FINDING_HINT} Use one finding per root cause, prefer a changed head-side line, and keep looking for additional distinct issues after recording one.`;
		default:
			return "Stay focused on distinct, evidence-backed issues introduced by the pull request.";
	}
}

function buildPostToolHint(
	toolName: ReviewToolName,
	findingCount: number,
	config: ReviewerConfig["review"],
	reviewedFileCount: number,
): string {
	const perFileSummariesEnabled =
		shouldCreatePerFileSummaries(reviewedFileCount);

	switch (toolName) {
		case "get_pr_overview":
			return "Choose the most suspicious files from the overview, inspect their diffs, and only call list_changed_files or get_ci_summary if the overview left a concrete gap.";
		case "list_changed_files":
			return "Prioritize files touching validation, auth, persistence, async flow, serialization, and public interfaces; do not stop after one risky file.";
		case "get_file_diff":
			return "If the diff looks risky, confirm the exact behavior in head/base code before deciding whether an issue exists.";
		case "get_file_diff_hunk":
			return "Continue with the next relevant hunk or matching code context until the file's meaningful changed behavior is covered; do not scan the repo unnecessarily.";
		case "get_file_content":
			return "Do not emit a finding unless the inspected code shows a concrete, material issue introduced by the PR, and keep checking for other distinct issues after confirming one.";
		case "get_file_list_by_directory":
		case "get_related_file_content":
		case "get_related_tests":
		case "search_text_in_repo":
		case "search_symbol_name":
			return "Use this context to confirm or reject a specific hypothesis, then move to the next uncovered risky path. If repeated searches are not sharpening the hypothesis, stop searching and decide based on the evidence you have.";
		case "get_ci_summary":
			return "CI may explain where to look next, but you still need code-level evidence before reporting anything.";
		case "record_pr_summary":
			return perFileSummariesEnabled
				? "Keep the PR summary concise and factual, then continue until each reviewed file also has a clear file-change summary."
				: `Keep the PR summary concise and factual. Per-file summaries are disabled for reviews with more than ${MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES} reviewed files, so continue reviewing without recording them.`;
		case "record_file_summary":
			return perFileSummariesEnabled
				? "Keep file summaries concrete and per-file; continue until all reviewed files have coverage."
				: `Per-file summaries are disabled for reviews with more than ${MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES} reviewed files; continue reviewing without recording them.`;
		case "list_recorded_findings":
			return `Recorded findings: ${findingCount}/${config.maxFindings}. Avoid duplicates, but continue looking if reviewed risky areas remain unchecked.`;
		case "remove_recorded_finding":
			return `Recorded findings: ${findingCount}/${config.maxFindings}. Keep only distinct issues, then continue covering remaining risky reviewed changes.`;
		case "replace_recorded_finding":
			return `Recorded findings: ${findingCount}/${config.maxFindings}. Keep the strongest distinct set without stopping the review early.`;
		case "emit_finding":
			return findingCount >= config.maxFindings
				? `You have reached the configured maximum of ${config.maxFindings} findings. Do not add more unless a clearly stronger issue replaces a weaker one.`
				: `Findings recorded: ${findingCount}/${config.maxFindings}. Keep findings distinct and evidence-backed, then continue searching for additional validated issues.`;
		default:
			return "Keep findings distinct, evidence-backed, and continue until the reviewed risky changes have been covered.";
	}
}

export function buildCopilotClientOptions(
	config: ReviewerConfig,
	resolveCliPath: () => string = resolveBundledCopilotCliPath,
): CopilotClientOptions {
	const clientLogLevel: CopilotClientOptions["logLevel"] =
		config.logLevel === "debug" ? "debug" : "error";

	return omitUndefined({
		cwd: config.repoRoot,
		logLevel: clientLogLevel,
		cliPath: resolveCliPath(),
	}) satisfies CopilotClientOptions;
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

	return toolResult as Record<string, unknown>;
}

function describeLoggedDirectories(value: unknown): string | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const directories = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => normalizeToolLogString(entry))
		.filter((entry) => entry.length > 0);
	if (directories.length === 0) {
		return undefined;
	}

	return directories.join(",");
}

function buildToolLogFields(toolName: string, toolArgs: unknown): string[] {
	const record = getToolArgsRecord(toolArgs);
	const field = (key: string, value: unknown): string | undefined => {
		const formatted = formatToolLogValue(value);
		return formatted ? `${key}=${formatted}` : undefined;
	};

	switch (toolName) {
		case "get_file_content":
		case "get_related_file_content":
			return [
				field("path", record.path),
				field("version", record.version),
				field("start", record.startLine),
				field("end", record.endLine),
			].filter((entry): entry is string => entry !== undefined);
		case "get_file_diff":
			return [field("path", record.path)].filter(
				(entry): entry is string => entry !== undefined,
			);
		case "get_file_diff_hunk":
			return [
				field("path", record.path),
				field("hunk", record.hunkIndex),
			].filter((entry): entry is string => entry !== undefined);
		case "get_file_list_by_directory":
			return [
				field("directories", describeLoggedDirectories(record.directories)),
				field("version", record.version),
			].filter((entry): entry is string => entry !== undefined);
		case "search_text_in_repo":
			return [
				field(
					"query_chars",
					typeof record.query === "string" ? record.query.length : undefined,
				),
				field("version", record.version),
				field("directories", describeLoggedDirectories(record.directories)),
				field("mode", record.mode),
			].filter((entry): entry is string => entry !== undefined);
		case "search_symbol_name":
			return [
				field(
					"symbol_chars",
					typeof record.symbol === "string" ? record.symbol.length : undefined,
				),
				field("version", record.version),
				field("directories", describeLoggedDirectories(record.directories)),
			].filter((entry): entry is string => entry !== undefined);
		case "record_pr_summary":
			return [
				field(
					"summary_chars",
					typeof record.summary === "string"
						? record.summary.length
						: undefined,
				),
			].filter((entry): entry is string => entry !== undefined);
		case "record_file_summary":
			return [field("path", record.path)].filter(
				(entry): entry is string => entry !== undefined,
			);
		case "remove_recorded_finding":
			return [field("finding", record.findingNumber)].filter(
				(entry): entry is string => entry !== undefined,
			);
		case "replace_recorded_finding":
			return [
				field("finding", record.findingNumber),
				field("path", record.path),
				field("line", record.line),
			].filter((entry): entry is string => entry !== undefined);
		case "emit_finding":
			return [field("path", record.path), field("line", record.line)].filter(
				(entry): entry is string => entry !== undefined,
			);
		default:
			return [];
	}
}

function buildToolResultLogFields(
	toolName: string,
	toolResult: ToolResultObject,
): string[] {
	const record = getToolResultRecord(toolResult);
	const field = (key: string, value: unknown): string | undefined => {
		const formatted = formatToolLogValue(value);
		return formatted ? `${key}=${formatted}` : undefined;
	};

	switch (toolName) {
		case "get_file_content":
		case "get_related_file_content":
			return [
				field("lines", record.returnedEndLine),
				field("status", record.status),
			].filter((entry): entry is string => entry !== undefined);
		case "get_file_diff":
		case "get_file_diff_hunk":
			return [
				field("truncated", record.truncated),
				field("patch_chars", record.returnedPatchChars),
				field("total_hunks", record.totalHunks),
			].filter((entry): entry is string => entry !== undefined);
		case "search_text_in_repo":
		case "search_symbol_name":
			return [
				field("matches", record.totalMatches),
				field("filtered", record.filteredMatchCount),
				field("truncated", record.truncated),
			].filter((entry): entry is string => entry !== undefined);
		case "get_file_list_by_directory":
			return [
				field("files", record.totalFiles),
				field("filtered", record.filteredFileCount),
				field("truncated", record.truncated),
			].filter((entry): entry is string => entry !== undefined);
		case "list_changed_files":
		case "get_pr_overview": {
			const reviewedFiles = Array.isArray(record.reviewedFiles)
				? record.reviewedFiles.length
				: undefined;
			const skippedFiles = Array.isArray(record.skippedFiles)
				? record.skippedFiles.length
				: undefined;
			return [
				field("reviewed_files", reviewedFiles),
				field("skipped_files", skippedFiles),
			].filter((entry): entry is string => entry !== undefined);
		}
		case "get_ci_summary":
			return [field("status", record.status)].filter(
				(entry): entry is string => entry !== undefined,
			);
		default:
			return [];
	}
}

function buildProgressFields(
	config: ReviewerConfig,
	drafts: FindingDraft[],
	progressState: ReviewProgressState,
): string[] {
	const fileSummaryProgress = shouldCreatePerFileSummaries(
		progressState.reviewedFileCount,
	)
		? `file_summaries=${progressState.summaryDrafts.fileSummaries.length}/${progressState.reviewedFileCount}`
		: "file_summaries=disabled";

	return [
		`findings=${drafts.length}/${config.review.maxFindings}`,
		fileSummaryProgress,
		`pr_summary=${progressState.summaryDrafts.prSummary ? "recorded" : "missing"}`,
	];
}

export { createEmptyReviewToolTelemetry };

function createEmptyToolTelemetryCounter(): ReviewToolTelemetryCounter {
	return {
		requested: 0,
		allowed: 0,
		denied: 0,
		completed: 0,
		resultCounts: {},
	};
}

function createEmptyReviewToolTelemetry(): ReviewToolTelemetry {
	return {
		totalRequested: 0,
		totalAllowed: 0,
		totalDenied: 0,
		totalCompleted: 0,
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
		formatToolLogValue(input.toolResult.error)
			? `error=${formatToolLogValue(input.toolResult.error)}`
			: undefined,
		...buildToolLogFields(input.toolName, input.toolArgs),
		...buildToolResultLogFields(input.toolName, input.toolResult),
		...buildProgressFields(config, drafts, progressState),
	]
		.filter((entry): entry is string => entry !== undefined)
		.join(" ");
}

export function createReviewSessionHooks(
	config: ReviewerConfig,
	logger: Logger,
	drafts: FindingDraft[],
	progressState: ReviewProgressState = {
		reviewedFileCount: 0,
		summaryDrafts: { fileSummaries: [] },
		toolTelemetry: createEmptyReviewToolTelemetry(),
	},
) {
	return {
		onSessionStart: async () => ({
			additionalContext: buildSessionHint(
				config,
				progressState.reviewedFileCount,
			),
		}),
		onPreToolUse: async (input: PreToolUseInput) => {
			const toolTelemetry =
				progressState.toolTelemetry ?? createEmptyReviewToolTelemetry();
			progressState.toolTelemetry = toolTelemetry;
			toolTelemetry.totalRequested += 1;
			getToolTelemetryCounter(toolTelemetry, input.toolName).requested += 1;

			logger.info(buildPreToolLogMessage(input));
			if (!isReviewToolName(input.toolName)) {
				toolTelemetry.totalDenied += 1;
				getToolTelemetryCounter(toolTelemetry, input.toolName).denied += 1;
				return {
					permissionDecision: "deny" as const,
					permissionDecisionReason: `Tool ${input.toolName} is not allowed in CI review mode.`,
				};
			}

			toolTelemetry.totalAllowed += 1;
			getToolTelemetryCounter(toolTelemetry, input.toolName).allowed += 1;

			return {
				permissionDecision: "allow" as const,
				additionalContext: buildPreToolHint(
					input.toolName,
					progressState.reviewedFileCount,
				),
			};
		},
		onPostToolUse: async (input: PostToolUseInput) => {
			const toolTelemetry =
				progressState.toolTelemetry ?? createEmptyReviewToolTelemetry();
			progressState.toolTelemetry = toolTelemetry;
			toolTelemetry.totalCompleted += 1;
			const counter = getToolTelemetryCounter(toolTelemetry, input.toolName);
			counter.completed += 1;
			const resultType = input.toolResult.resultType;
			counter.resultCounts[resultType] =
				(counter.resultCounts[resultType] ?? 0) + 1;

			logger.info(
				buildPostToolLogMessage(input, config, drafts, progressState),
			);
			if (!isReviewToolName(input.toolName)) {
				return {
					additionalContext:
						"Keep findings distinct, evidence-backed, and continue until the reviewed risky changes have been covered.",
				};
			}

			return {
				additionalContext: buildPostToolHint(
					input.toolName,
					drafts.length,
					config.review,
					progressState.reviewedFileCount,
				),
			};
		},
		onErrorOccurred: async (input: {
			errorContext: string;
			error: unknown;
		}) => {
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
	assistantMessage: string | undefined,
	findingsCount: number,
): string {
	if (context.reviewedFiles.length === 0) {
		return "No reviewable files remained after exclusions, so no AI review was performed.";
	}

	if (findingsCount === 0) {
		const normalized = assistantMessage?.trim();
		if (normalized && normalized.length > 0) {
			return truncateText(normalized, 1200, { suffix: "\n... truncated ..." });
		}

		return `No ${context.reviewedFiles.length > 0 ? "reportable" : "reviewable"} issues found in the reviewed pull request changes at the ${"configured confidence threshold"}.`;
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
	if (context.reviewedFiles.length === 0) {
		return {
			summary: summarizeOutcome(context, undefined, 0),
			findings: [],
			stale: false,
		};
	}

	const drafts: FindingDraft[] = [];
	const summaryDrafts: ReviewSummaryDrafts = { fileSummaries: [] };
	const toolTelemetry = createEmptyReviewToolTelemetry();
	const clientOptions = buildCopilotClientOptions(
		config,
		dependencies.resolveCliPath,
	);

	const client =
		dependencies.createCopilotClient?.(clientOptions) ??
		new CopilotClient(clientOptions);
	await client.start();
	const session = await (dependencies.createReviewSession?.({
		client,
		config,
		context,
		git,
		logger,
		drafts,
		summaryDrafts,
	}) ??
		client.createSession({
			clientName: "bitbucket-copilot-pr-review",
			model: config.copilot.model,
			reasoningEffort: config.copilot.reasoningEffort,
			streaming: true,
			tools: createReviewTools(config, context, git, drafts, summaryDrafts),
			availableTools: [...REVIEW_TOOL_NAMES],
			onPermissionRequest: approveAll,
			hooks: createReviewSessionHooks(config, logger, drafts, {
				reviewedFileCount: context.reviewedFiles.length,
				summaryDrafts,
				toolTelemetry,
			}),
			workingDirectory: config.repoRoot,
			infiniteSessions: { enabled: false },
		}));

	wireReasoningTrace(session, logger);

	try {
		const response = await session.sendAndWait(
			{ prompt: buildPrompt(config, context) },
			config.copilot.timeoutMs,
		);
		const findings = finalizeFindings(
			drafts,
			context.reviewedFiles,
			config.review.maxFindings,
			config.review.minConfidence,
		);
		const reviewSummary = finalizeReviewSummary(context, summaryDrafts);
		const assistantMessage = response?.data.content;

		return omitUndefined({
			summary: summarizeOutcome(context, assistantMessage, findings.length),
			findings,
			assistantMessage,
			prSummary: reviewSummary.prSummary,
			fileSummaries: reviewSummary.fileSummaries,
			toolTelemetry,
			stale: false,
		}) satisfies ReviewOutcome;
	} finally {
		await session.disconnect();
		const errors = await client.stop();
		for (const error of errors) {
			logger.warn("Copilot client cleanup reported an error", error);
		}
	}
}

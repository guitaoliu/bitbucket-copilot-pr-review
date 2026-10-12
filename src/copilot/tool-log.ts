import { truncateText } from "../shared/text.ts";
import type { CompletedToolCall } from "./telemetry.ts";
import type { ReviewToolState } from "./tools/context.ts";

const MAX_TOOL_LOG_VALUE_LENGTH = 80;
const REPOSITORY_INSPECTION_TOOL_NAMES: ReadonlySet<string> = new Set([
	"review_changes",
	"read_file",
	"search_repo",
	"find_files",
]);

function formatToolLogValue(value: unknown): string | undefined {
	if (typeof value === "string") {
		const normalized = truncateText(
			value.replace(/\s+/g, " ").trim(),
			MAX_TOOL_LOG_VALUE_LENGTH,
			{ suffix: "...", preserveMaxLength: true },
		);
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

function formatFields(fields: Array<[string, unknown]>): string[] {
	return fields.flatMap(([key, value]) => {
		const formatted = formatToolLogValue(value);
		return formatted ? [`${key}=${formatted}`] : [];
	});
}

function buildToolArgumentFields(
	toolName: string,
	toolArgs: unknown,
): Array<[string, unknown]> {
	const args =
		toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)
			? (toolArgs as Record<string, unknown>)
			: {};
	const count = (value: unknown) =>
		Array.isArray(value) ? value.length : undefined;

	switch (toolName) {
		case "review_changes":
			return [["page", args.page ?? 1]];
		case "read_file":
			return [
				["revision", args.revision],
				["path", args.path],
				["page", args.page ?? 1],
			];
		case "search_repo":
			return [
				["revision", args.revision],
				["patterns", count(args.patterns) ?? 0],
				["pattern_type", args.patternType ?? "literal"],
				["paths", count(args.paths) ?? 0],
				["page", args.page ?? 1],
			];
		case "find_files":
			return [
				["revision", args.revision],
				["paths", count(args.paths) ?? 0],
				["page", args.page ?? 1],
			];
		case "record_pr_summary":
			return [
				[
					"summary_chars",
					typeof args.summary === "string" ? args.summary.length : undefined,
				],
			];
		case "record_change_area_summary":
			return [
				["title", args.title],
				["paths", count(args.paths)],
			];
		case "emit_finding":
			return [
				["path", args.path],
				["line", args.line],
			];
		default:
			return [];
	}
}

export function buildToolRequestLogMessage(
	toolName: string,
	toolArgs: unknown,
): string {
	return [
		"Copilot requested tool",
		toolName,
		...formatFields(buildToolArgumentFields(toolName, toolArgs)),
	].join(" ");
}

export function buildToolCompletionLog(
	call: CompletedToolCall,
	state: ReviewToolState,
): { message: string; details?: { result: string } } {
	const message = [
		"Copilot completed tool",
		call.toolName,
		...formatFields([
			["result", call.resultType],
			["duration_ms", call.durationMs],
			["error", call.error],
			...buildToolArgumentFields(call.toolName, call.arguments),
			["findings", state.drafts.length],
			["dropped_findings_unknown_file", state.droppedFindings.unknown_file],
			["dropped_findings_unchanged_line", state.droppedFindings.unchanged_line],
			["pr_summary", state.summaryDrafts.prSummary ? "recorded" : "missing"],
		]),
	].join(" ");
	return call.result && !REPOSITORY_INSPECTION_TOOL_NAMES.has(call.toolName)
		? { message, details: { result: call.result } }
		: { message };
}

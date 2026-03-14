export const BITBUCKET_PR_COMMENT_MAX_CHARS = 32000;

export interface TruncateTextOptions {
	suffix?: string;
	preserveMaxLength?: boolean;
}

export function truncateText(
	value: string,
	maxChars: number,
	options: TruncateTextOptions = {},
): string {
	if (value.length <= maxChars) {
		return value;
	}

	const suffix = options.suffix ?? "... truncated ...";
	const sliceLength = options.preserveMaxLength
		? Math.max(0, maxChars - suffix.length)
		: maxChars;

	return `${value.slice(0, sliceLength).trimEnd()}${suffix}`;
}

export function formatFileSlice(
	content: string,
	startLine: number,
	endLine: number,
): string {
	const lines = content.split(/\r?\n/);
	const safeStart = Math.max(1, startLine);
	const safeEnd = Math.min(lines.length, Math.max(safeStart, endLine));
	const width = String(safeEnd).length;

	return lines
		.slice(safeStart - 1, safeEnd)
		.map(
			(line, index) =>
				`${String(safeStart + index).padStart(width, " ")}: ${line}`,
		)
		.join("\n");
}

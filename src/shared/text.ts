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

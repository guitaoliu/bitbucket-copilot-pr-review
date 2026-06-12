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

export function sanitizeModelAuthoredText(value: string): string {
	return value
		.replaceAll("<!--", "&lt;!--")
		.replaceAll("-->", "--&gt;")
		.replace(
			/(^|[^A-Za-z0-9_])@(all|channel|everyone|here)\b/gi,
			(_match, prefix: string, mention: string) =>
				`${prefix}[at]${mention.toLowerCase()}`,
		);
}

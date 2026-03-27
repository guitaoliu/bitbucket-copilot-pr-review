import { truncateText } from "../shared/text.ts";

export const MAX_PR_DESCRIPTION_CHARS = 2000;

export function escapePromptMarkupText(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function truncatePullRequestDescription(description: string): {
	content?: string;
	truncated?: boolean;
	originalChars?: number;
} {
	const trimmed = description.trim();
	if (trimmed.length === 0) {
		return {};
	}

	const truncated = trimmed.length > MAX_PR_DESCRIPTION_CHARS;
	const content = truncateText(trimmed, MAX_PR_DESCRIPTION_CHARS, {
		preserveMaxLength: true,
	});

	return truncated
		? {
				content,
				truncated: true,
				originalChars: trimmed.length,
			}
		: { content };
}

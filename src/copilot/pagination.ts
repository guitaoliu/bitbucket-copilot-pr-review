export interface PagedContent {
	page: number;
	totalPages: number;
	content: string;
	nextPage?: number;
	outOfRange?: true;
	requestedPage?: number;
	paginationReset?: true;
}

const DEFAULT_PAGE_CONTENT_BYTES = 40_000;

function takeUtf8Prefix(
	value: string,
	maxBytes: number,
): { content: string; consumed: number } {
	let bytes = 0;
	let consumed = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character);
		if (bytes + characterBytes > maxBytes) {
			break;
		}
		bytes += characterBytes;
		consumed += character.length;
	}
	return { content: value.slice(0, consumed), consumed };
}

export function paginateContent(
	content: string,
	maxBytes = DEFAULT_PAGE_CONTENT_BYTES,
): string[] {
	const pages: string[] = [];
	let offset = 0;
	while (offset < content.length) {
		const remaining = content.slice(offset);
		const prefix = takeUtf8Prefix(remaining, maxBytes);
		let consumed = prefix.consumed;
		let pageContent = prefix.content;
		if (consumed < remaining.length) {
			const newline = pageContent.lastIndexOf("\n");
			if (newline >= 0) {
				consumed = newline + 1;
				pageContent = remaining.slice(0, consumed);
			}
		}
		pages.push(pageContent);
		offset += consumed;
	}
	return pages.length > 0 ? pages : [""];
}

export function selectPage(
	pages: readonly string[],
	page: number,
): PagedContent {
	if (page > pages.length) {
		return {
			page,
			totalPages: pages.length,
			content: "",
			outOfRange: true,
		};
	}
	return {
		page,
		totalPages: pages.length,
		content: pages[page - 1] ?? "",
		...(page < pages.length ? { nextPage: page + 1 } : {}),
	};
}

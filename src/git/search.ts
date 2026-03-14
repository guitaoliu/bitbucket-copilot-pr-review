export interface GitTextSearchMatch {
	path: string;
	line: number;
	text: string;
}

export interface GitTextSearchResult {
	matches: GitTextSearchMatch[];
	truncated: boolean;
	totalMatches: number;
}

export function parseGitGrepLine(line: string): GitTextSearchMatch | undefined {
	const match = /^([^:]+:)?(.+?):(\d+):(.*)$/.exec(line);
	if (!match) {
		return undefined;
	}

	const path = match[2];
	const lineNumber = Number.parseInt(match[3] ?? "0", 10);
	const text = match[4] ?? "";
	if (!path || !Number.isFinite(lineNumber) || lineNumber <= 0) {
		return undefined;
	}

	return {
		path,
		line: lineNumber,
		text,
	};
}

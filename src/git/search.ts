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

function splitOnce(
	value: string,
	separator: string,
): [string, string] | undefined {
	const separatorIndex = value.indexOf(separator);
	if (separatorIndex < 0) {
		return undefined;
	}

	return [
		value.slice(0, separatorIndex),
		value.slice(separatorIndex + separator.length),
	];
}

function stripOptionalTreeishPrefix(path: string): string {
	const pathParts = splitOnce(path, ":");
	if (!pathParts) {
		return path;
	}

	const [prefix, remainder] = pathParts;
	if (/^[0-9a-fA-F]{4,64}$/.test(prefix) && remainder.length > 0) {
		return remainder;
	}

	return path;
}

export function parseGitGrepLine(line: string): GitTextSearchMatch | undefined {
	const lineParts = line.split("\u0000");
	if (lineParts.length === 3) {
		const pathWithTreeish = lineParts[0] ?? "";
		const lineText = lineParts[1] ?? "";
		const text = lineParts[2] ?? "";
		const path = stripOptionalTreeishPrefix(pathWithTreeish);
		const lineNumber = Number.parseInt(lineText, 10);
		if (!path || !Number.isFinite(lineNumber) || lineNumber <= 0) {
			return undefined;
		}

		return {
			path,
			line: lineNumber,
			text,
		};
	}

	const lineMatch = /^(.*):(\d+):(.*)$/.exec(line);
	if (!lineMatch) {
		return undefined;
	}

	const path = stripOptionalTreeishPrefix(lineMatch[1] ?? "");
	const lineNumber = Number.parseInt(lineMatch[2] ?? "0", 10);
	const text = lineMatch[3] ?? "";
	if (!path || !Number.isFinite(lineNumber) || lineNumber <= 0) {
		return undefined;
	}

	return {
		path,
		line: lineNumber,
		text,
	};
}

import type { ChangedFile, DiffStats, FileStatus } from "./types.ts";

interface LineStats {
	additions: number;
	deletions: number;
	isBinary: boolean;
}

const C_STYLE_ESCAPES: Record<string, string> = {
	a: "\x07",
	b: "\b",
	t: "\t",
	n: "\n",
	v: "\v",
	f: "\f",
	r: "\r",
};

function splitNulRecords(value: string): string[] {
	const records = value.split("\0");
	if (records.at(-1) === "") {
		records.pop();
	}
	return records;
}

function mapStatusCode(code: string): FileStatus | undefined {
	switch (code[0]) {
		case "A":
			return "added";
		case "M":
		case "T":
			return "modified";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		default:
			return undefined;
	}
}

function parseNumstatRecord(
	record: string,
): (LineStats & { path: string }) | undefined {
	const firstTab = record.indexOf("\t");
	const secondTab = record.indexOf("\t", firstTab + 1);
	if (firstTab < 0 || secondTab < 0) {
		return undefined;
	}

	const rawAdditions = record.slice(0, firstTab);
	const rawDeletions = record.slice(firstTab + 1, secondTab);
	const isBinary = rawAdditions === "-" || rawDeletions === "-";
	return {
		path: record.slice(secondTab + 1),
		additions: isBinary ? 0 : Number.parseInt(rawAdditions, 10),
		deletions: isBinary ? 0 : Number.parseInt(rawDeletions, 10),
		isBinary,
	};
}

/**
 * Parses `git diff --raw --numstat -z` output: every raw record comes first,
 * then one numstat record per file pair, keyed here by the head-side path.
 */
export function parseChangedFiles(diffText: string): ChangedFile[] {
	const records = splitNulRecords(diffText);
	const pairs: Array<Pick<ChangedFile, "path" | "oldPath" | "status">> = [];
	let index = 0;
	while (records[index]?.startsWith(":")) {
		const header = records[index++] ?? "";
		const status = mapStatusCode(header.slice(header.lastIndexOf(" ") + 1));
		if (status === "renamed" || status === "copied") {
			const oldPath = records[index++];
			const path = records[index++];
			if (oldPath && path) {
				pairs.push({ path, oldPath, status });
			}
			continue;
		}

		const path = records[index++];
		if (status && path) {
			pairs.push({ path, status });
		}
	}

	const statsByPath = new Map<string, LineStats>();
	while (index < records.length) {
		const stats = parseNumstatRecord(records[index++] ?? "");
		if (!stats) {
			continue;
		}
		let { path } = stats;
		if (path === "") {
			index += 1;
			path = records[index++] ?? "";
		}
		statsByPath.set(path, stats);
	}

	return pairs.map((pair) => {
		const stats = statsByPath.get(pair.path);
		return {
			...pair,
			additions: stats?.additions ?? 0,
			deletions: stats?.deletions ?? 0,
			isBinary: stats?.isBinary ?? false,
		};
	});
}

export function summarizeDiffStats(files: readonly ChangedFile[]): DiffStats {
	return {
		fileCount: files.length,
		additions: files.reduce((total, file) => total + file.additions, 0),
		deletions: files.reduce((total, file) => total + file.deletions, 0),
	};
}

function unquoteGitPath(value: string): string {
	if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
		return value;
	}

	return value
		.slice(1, -1)
		.replace(
			/\\(?:([0-7]{3})|(.))/g,
			(_match, octal?: string, char?: string) =>
				octal !== undefined
					? String.fromCharCode(Number.parseInt(octal, 8))
					: (C_STYLE_ESCAPES[char ?? ""] ?? char ?? ""),
		);
}

function readQuotedPrefix(value: string): string | undefined {
	for (let index = 1; index < value.length; index += 1) {
		if (value[index] === "\\") {
			index += 1;
		} else if (value[index] === '"') {
			return value.slice(0, index + 1);
		}
	}
	return undefined;
}

/**
 * Returns the head-side path of a `diff --git a/<old> b/<new>` header when it
 * is unambiguous. Rename and copy headers are resolved from their own
 * `rename to` / `copy to` lines instead.
 */
function parseDiffHeaderPath(line: string): string | undefined {
	const sides = line.slice("diff --git ".length);
	if (sides.startsWith('"')) {
		const oldSide = readQuotedPrefix(sides);
		const newSide =
			oldSide === undefined ? undefined : sides.slice(oldSide.length + 1);
		return newSide ? unquoteGitPath(newSide).replace(/^b\//, "") : undefined;
	}

	const pathLength = (sides.length - "a/ b/".length) / 2;
	if (
		Number.isInteger(pathLength) &&
		sides.startsWith("a/") &&
		sides.slice(2 + pathLength, 5 + pathLength) === " b/" &&
		sides.slice(2, 2 + pathLength) === sides.slice(5 + pathLength)
	) {
		return sides.slice(2, 2 + pathLength);
	}
	return undefined;
}

/**
 * Maps each head-side path in a unified diff to its added head lines, taken
 * from `+` lines only so context lines never count as changed.
 */
export function parseChangedLines(
	diffText: string,
): ReadonlyMap<string, readonly number[]> {
	const changedLinesByPath = new Map<string, readonly number[]>();
	let path: string | undefined;
	let changedLines: number[] = [];
	let oldRemaining = 0;
	let newRemaining = 0;
	let nextNewLine = 0;

	const finishFile = () => {
		if (path !== undefined) {
			changedLinesByPath.set(path, changedLines);
		}
	};

	for (const line of diffText.split("\n")) {
		if (oldRemaining > 0 || newRemaining > 0) {
			if (line.startsWith("+")) {
				changedLines.push(nextNewLine);
				nextNewLine += 1;
				newRemaining -= 1;
			} else if (line.startsWith("-")) {
				oldRemaining -= 1;
			} else if (line.startsWith(" ")) {
				nextNewLine += 1;
				oldRemaining -= 1;
				newRemaining -= 1;
			}
			continue;
		}

		if (line.startsWith("diff --git ")) {
			finishFile();
			path = parseDiffHeaderPath(line);
			changedLines = [];
			continue;
		}

		if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
			path = unquoteGitPath(line.slice(line.indexOf(" to ") + 4));
			continue;
		}

		const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk) {
			oldRemaining = Number.parseInt(hunk[1] ?? "1", 10);
			nextNewLine = Number.parseInt(hunk[2] ?? "0", 10);
			newRemaining = Number.parseInt(hunk[3] ?? "1", 10);
		}
	}
	finishFile();

	return changedLinesByPath;
}

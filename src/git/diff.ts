import { omitUndefined } from "../shared/object.ts";
import type {
	ChangedFile,
	DiffStats,
	FileStatus,
	HunkSummary,
} from "./types.ts";

interface MutableHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	header: string;
	changedLines: number[];
	nextOldLine: number;
	nextNewLine: number;
}

interface MutableFile {
	path: string;
	oldPath?: string;
	status: FileStatus;
	patchLines: string[];
	changedLineSet: Set<number>;
	hunks: HunkSummary[];
	additions: number;
	deletions: number;
	isBinary: boolean;
	currentHunk?: MutableHunk;
}

function normalizePath(value: string): string {
	return value.replace(/^"|"$/g, "").replace(/\\/g, "/");
}

function splitNulRecords(value: string): string[] {
	const records = value.split("\0");
	if (records.at(-1) === "") {
		records.pop();
	}
	return records;
}

function mapNameStatusCode(code: string): FileStatus | undefined {
	switch (code[0]) {
		case "A":
			return "added";
		case "M":
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

export function parseNameStatusDiff(diffText: string): ChangedFile[] {
	const records = splitNulRecords(diffText);
	const files: ChangedFile[] = [];
	for (let index = 0; index < records.length; ) {
		const statusCode = records[index++] ?? "";
		const status = mapNameStatusCode(statusCode);
		if (!status) {
			continue;
		}

		if (status === "renamed" || status === "copied") {
			const oldPath = records[index++];
			const newPath = records[index++];
			if (oldPath && newPath) {
				files.push({
					path: normalizePath(newPath),
					oldPath: normalizePath(oldPath),
					status,
					additions: 0,
					deletions: 0,
					isBinary: false,
				});
			}
			continue;
		}

		const filePath = records[index++];
		if (filePath) {
			files.push({
				path: normalizePath(filePath),
				status,
				additions: 0,
				deletions: 0,
				isBinary: false,
			});
		}
	}
	return files;
}

export function applyNumstatDiff(
	files: ChangedFile[],
	diffText: string,
): DiffStats {
	const records = splitNulRecords(diffText);
	let recordIndex = 0;
	let additions = 0;
	let deletions = 0;

	for (const file of files) {
		const statRecord = records[recordIndex++] ?? "";
		const [rawAdditions, rawDeletions, embeddedPath] = statRecord.split("\t");
		const isBinary = rawAdditions === "-" || rawDeletions === "-";
		file.isBinary = isBinary;
		file.additions = isBinary ? 0 : Number.parseInt(rawAdditions ?? "0", 10);
		file.deletions = isBinary ? 0 : Number.parseInt(rawDeletions ?? "0", 10);

		if (
			embeddedPath === "" &&
			(file.status === "renamed" || file.status === "copied")
		) {
			recordIndex += 2;
		}

		additions += file.additions;
		deletions += file.deletions;
	}

	return {
		fileCount: files.length,
		additions,
		deletions,
	};
}

function parseDiffHeader(
	line: string,
): { oldPath: string; newPath: string } | undefined {
	const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
	if (!match) {
		return undefined;
	}

	return {
		oldPath: normalizePath(match[1] ?? ""),
		newPath: normalizePath(match[2] ?? ""),
	};
}

function finishHunk(file: MutableFile): void {
	const { currentHunk } = file;
	if (!currentHunk) {
		return;
	}

	file.hunks.push({
		oldStart: currentHunk.oldStart,
		oldLines: currentHunk.oldLines,
		newStart: currentHunk.newStart,
		newLines: currentHunk.newLines,
		header: currentHunk.header,
		changedLines: [...new Set(currentHunk.changedLines)].sort(
			(left, right) => left - right,
		),
	});

	delete file.currentHunk;
}

function finishFile(file: MutableFile | undefined): ChangedFile | undefined {
	if (!file) {
		return undefined;
	}

	finishHunk(file);

	return omitUndefined({
		path: file.path,
		oldPath: file.oldPath,
		status: file.status,
		patch: file.patchLines.join("\n").trimEnd(),
		changedLines: [...file.changedLineSet].sort((left, right) => left - right),
		hunks: file.hunks,
		additions: file.additions,
		deletions: file.deletions,
		isBinary: file.isBinary,
	}) satisfies ChangedFile;
}

export function parseUnifiedDiff(diffText: string): {
	files: ChangedFile[];
	stats: DiffStats;
} {
	const files: ChangedFile[] = [];
	const lines = diffText.length > 0 ? diffText.split(/\r?\n/) : [];
	let currentFile: MutableFile | undefined;

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			const parsed = finishFile(currentFile);
			if (parsed) {
				files.push(parsed);
			}

			const header = parseDiffHeader(line);
			if (!header) {
				currentFile = undefined;
				continue;
			}

			currentFile = omitUndefined({
				path: header.newPath,
				oldPath: header.oldPath !== header.newPath ? header.oldPath : undefined,
				status: "modified" as const,
				patchLines: [line] as string[],
				changedLineSet: new Set<number>(),
				hunks: [] as HunkSummary[],
				additions: 0,
				deletions: 0,
				isBinary: false,
			}) satisfies MutableFile;
			continue;
		}

		if (!currentFile) {
			continue;
		}

		currentFile.patchLines.push(line);

		if (line.startsWith("new file mode ")) {
			currentFile.status = "added";
			continue;
		}

		if (line.startsWith("deleted file mode ")) {
			currentFile.status = "deleted";
			continue;
		}

		if (line.startsWith("rename from ")) {
			currentFile.status = "renamed";
			currentFile.oldPath = normalizePath(line.slice("rename from ".length));
			continue;
		}

		if (line.startsWith("rename to ")) {
			currentFile.path = normalizePath(line.slice("rename to ".length));
			continue;
		}

		if (line.startsWith("copy from ")) {
			currentFile.status = "copied";
			currentFile.oldPath = normalizePath(line.slice("copy from ".length));
			continue;
		}

		if (line.startsWith("copy to ")) {
			currentFile.path = normalizePath(line.slice("copy to ".length));
			continue;
		}

		if (line.startsWith("Binary files ")) {
			currentFile.isBinary = true;
			continue;
		}

		const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(
			line,
		);
		if (hunkMatch) {
			finishHunk(currentFile);
			currentFile.currentHunk = {
				oldStart: Number.parseInt(hunkMatch[1] ?? "0", 10),
				oldLines: Number.parseInt(hunkMatch[2] || "1", 10),
				newStart: Number.parseInt(hunkMatch[3] ?? "0", 10),
				newLines: Number.parseInt(hunkMatch[4] || "1", 10),
				header: (hunkMatch[5] ?? "").trim(),
				changedLines: [],
				nextOldLine: Number.parseInt(hunkMatch[1] ?? "0", 10),
				nextNewLine: Number.parseInt(hunkMatch[3] ?? "0", 10),
			};
			continue;
		}

		const hunk = currentFile.currentHunk;
		if (!hunk) {
			continue;
		}

		if (line.startsWith("+") && !line.startsWith("+++")) {
			currentFile.additions += 1;
			currentFile.changedLineSet.add(hunk.nextNewLine);
			hunk.changedLines.push(hunk.nextNewLine);
			hunk.nextNewLine += 1;
			continue;
		}

		if (line.startsWith("-") && !line.startsWith("---")) {
			currentFile.deletions += 1;
			hunk.nextOldLine += 1;
			continue;
		}

		if (line.startsWith(" ")) {
			hunk.nextOldLine += 1;
			hunk.nextNewLine += 1;
		}
	}

	const parsed = finishFile(currentFile);
	if (parsed) {
		files.push(parsed);
	}

	const stats = files.reduce<DiffStats>(
		(result, file) => ({
			fileCount: result.fileCount + 1,
			additions: result.additions + file.additions,
			deletions: result.deletions + file.deletions,
		}),
		{ fileCount: 0, additions: 0, deletions: 0 },
	);

	return { files, stats };
}

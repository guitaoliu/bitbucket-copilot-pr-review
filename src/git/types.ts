export type FileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied";

export interface HunkSummary {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	header: string;
	changedLines: number[];
}

export interface ChangedFile {
	path: string;
	oldPath?: string;
	status: FileStatus;
	patch: string;
	changedLines: number[];
	hunks: HunkSummary[];
	additions: number;
	deletions: number;
	isBinary: boolean;
}

export interface SkippedFile {
	path: string;
	oldPath?: string;
	status: FileStatus;
	reason: string;
}

export interface DiffStats {
	fileCount: number;
	additions: number;
	deletions: number;
}

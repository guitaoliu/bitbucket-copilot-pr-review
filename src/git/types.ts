export type FileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied";

export interface ChangedFile {
	path: string;
	oldPath?: string;
	status: FileStatus;
	additions: number;
	deletions: number;
	isBinary: boolean;
}

export interface ReviewableFile extends ChangedFile {
	/** Sorted head-side lines added or modified by the change. */
	readonly changedLines: readonly number[];
	/** Head-side text of each changed line, keyed by line number. */
	readonly changedLineText: ReadonlyMap<number, string>;
}

export interface DiffStats {
	fileCount: number;
	additions: number;
	deletions: number;
}

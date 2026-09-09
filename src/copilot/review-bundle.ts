import { posix as path } from "node:path";

import type { GitRepository } from "../git/repo.ts";
import type { ChangedFile } from "../git/types.ts";
import type { ReviewContext } from "../review/types.ts";

const PAGE_CONTENT_BYTES = 40_000;

export interface PagedContent {
	page: number;
	totalPages: number;
	content: string;
	nextPage?: number;
	outOfRange?: true;
	requestedPage?: number;
	paginationReset?: true;
}

export interface ReviewCoverage {
	deliveredPages: number;
	totalPages?: number;
	complete: boolean;
}

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

function paginateContent(
	content: string,
	maxBytes = PAGE_CONTENT_BYTES,
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
	content: string,
	page: number,
	maxBytes = PAGE_CONTENT_BYTES,
): PagedContent {
	const pages = paginateContent(content, maxBytes);
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

function isApplicableGuide(guidePath: string, files: ChangedFile[]): boolean {
	if (guidePath === "AGENTS.md") {
		return true;
	}
	const directory = path.dirname(guidePath);
	return files.some((file) =>
		[file.path, file.oldPath].some((filePath) =>
			filePath?.startsWith(`${directory}/`),
		),
	);
}

function extractSkillFrontmatter(content: string): string | undefined {
	const lines = content.split(/\r?\n/);
	if (lines[0] !== "---") {
		return undefined;
	}
	const end = lines.indexOf("---", 1);
	return end > 1 ? lines.slice(1, end).join("\n") : undefined;
}

export class ReviewBundle {
	private readonly context: ReviewContext;
	private readonly git: GitRepository;
	private readonly deliveredPages = new Set<number>();
	private pages?: Promise<string[]>;
	private totalPages?: number;

	constructor(context: ReviewContext, git: GitRepository) {
		this.context = context;
		this.git = git;
	}

	async getPage(
		page = 1,
	): Promise<PagedContent & { coverage: ReviewCoverage }> {
		const pages = await this.getPages();
		if (page > pages.length) {
			throw new Error(`Page ${page} exceeds total pages ${pages.length}.`);
		}
		this.deliveredPages.add(page);
		return {
			page,
			totalPages: pages.length,
			content: pages[page - 1] ?? "",
			coverage: this.getCoverage(),
		};
	}

	getCoverage(): ReviewCoverage {
		return {
			deliveredPages: this.deliveredPages.size,
			...(this.totalPages === undefined ? {} : { totalPages: this.totalPages }),
			complete:
				this.totalPages !== undefined &&
				this.deliveredPages.size === this.totalPages,
		};
	}

	async getMissingPages(): Promise<number[]> {
		const pages = await this.getPages();
		return pages.flatMap((_content, index) =>
			this.deliveredPages.has(index + 1) ? [] : [index + 1],
		);
	}

	private async getPages(): Promise<string[]> {
		this.pages ??= this.buildPages();
		const pages = await this.pages;
		this.totalPages = pages.length;
		return pages;
	}

	private async buildPages(): Promise<string[]> {
		const trackedGuidance = await this.git.listFilesAtCommit(
			this.context.baseCommit,
			["**/AGENTS.md", ".agents/skills/*/SKILL.md"],
		);
		const paths = trackedGuidance.split(/\r?\n/).filter(Boolean);
		const guidePaths = paths
			.filter((entry) => entry.endsWith("AGENTS.md"))
			.filter((entry) =>
				isApplicableGuide(entry, this.context.reviewableFiles),
			);
		const skillPaths = paths.filter((entry) => entry.endsWith("/SKILL.md"));
		const guides = await Promise.all(
			guidePaths.map(async (guidePath) => {
				const result = await this.git.readTextFileAtCommit(
					this.context.baseCommit,
					guidePath,
				);
				return `=== trusted guidance: ${guidePath} ===\n${result.status === "ok" ? result.content : `[${result.status}]`}`;
			}),
		);
		const skills = await Promise.all(
			skillPaths.map(async (skillPath) => {
				const result = await this.git.readTextFileAtCommit(
					this.context.baseCommit,
					skillPath,
				);
				const frontmatter =
					result.status === "ok"
						? extractSkillFrontmatter(result.content)
						: undefined;
				return frontmatter ? `--- ${skillPath} ---\n${frontmatter}` : skillPath;
			}),
		);
		const diffPaths = this.context.reviewableFiles.flatMap((file) =>
			file.oldPath ? [file.oldPath, file.path] : [file.path],
		);
		const diff = await this.git.diffPaths(
			this.context.mergeBaseCommit,
			this.context.headCommit,
			diffPaths,
			3,
		);
		return paginateContent(
			[
				...guides,
				...(skills.length > 0
					? [`=== trusted skill catalog ===\n${skills.join("\n")}`]
					: []),
				`=== review diff ===\n${diff || "[no textual diff]"}`,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
	}
}

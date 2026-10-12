import { posix as path } from "node:path";

import type { GitRepository } from "../git/repo.ts";
import type { ChangedFile } from "../git/types.ts";
import type { ReviewScope } from "../review/types.ts";
import {
	type PagedContent,
	paginateContent,
	selectPage,
} from "./pagination.ts";

const GUIDANCE_PATH_GLOBS = ["**/AGENTS.md", ".agents/skills/*/SKILL.md"];

export interface ReviewCoverage {
	deliveredPages: number;
	totalPages?: number;
	complete: boolean;
}

function isApplicableGuide(
	guidePath: string,
	files: readonly ChangedFile[],
): boolean {
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
	private readonly context: ReviewScope;
	private readonly git: GitRepository;
	private readonly deliveredPages = new Set<number>();
	private pages?: Promise<string[]>;
	private totalPages?: number;

	constructor(context: ReviewScope, git: GitRepository) {
		this.context = context;
		this.git = git;
	}

	async getPage(
		page: number,
	): Promise<PagedContent & { coverage: ReviewCoverage }> {
		const result = selectPage(await this.getPages(), page);
		if (!result.outOfRange) {
			this.deliveredPages.add(page);
		}
		return { ...result, coverage: this.getCoverage() };
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
		const paths = (
			await this.git.listFilesAtCommit(this.context.baseCommit)
		).filter((entry) =>
			GUIDANCE_PATH_GLOBS.some((pattern) => path.matchesGlob(entry, pattern)),
		);
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
		return paginateContent(
			[
				...guides,
				...(skills.length > 0
					? [`=== trusted skill catalog ===\n${skills.join("\n")}`]
					: []),
				`=== review diff ===\n${this.context.reviewDiff || "[no textual diff]"}`,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
	}
}

import { createHash } from "node:crypto";

import { z } from "zod";
import type { ReviewableFile } from "../git/types.ts";
import { omitUndefined } from "../shared/object.ts";
import { sanitizeModelAuthoredText } from "../shared/text.ts";
import { buildFindingThreadKey } from "./finding-identity.ts";
import { formatLineRanges } from "./line-ranges.ts";
import {
	ANNOTATION_TYPE_VALUES,
	CONFIDENCE_VALUES,
	type Confidence,
	type FindingDraft,
	type ReviewFinding,
	SEVERITY_VALUES,
} from "./types.ts";

const CONFIDENCE_RANK: Record<Confidence, number> = {
	low: 1,
	medium: 2,
	high: 3,
};

const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = {
	LOW: 1,
	MEDIUM: 2,
	HIGH: 3,
};

const TYPE_RANK: Record<ReviewFinding["type"], number> = {
	CODE_SMELL: 1,
	BUG: 2,
	VULNERABILITY: 3,
};

export type FindingRejectionReason = "unknown_file" | "unchanged_line";

export type FindingLocationResult =
	| { ok: true; draft: FindingDraft; note?: string }
	| { ok: false; reason: FindingRejectionReason; message: string };

function compareFindingPriority(
	left: Pick<ReviewFinding, "severity" | "type" | "confidence">,
	right: Pick<ReviewFinding, "severity" | "type" | "confidence">,
): number {
	return (
		SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
		TYPE_RANK[left.type] - TYPE_RANK[right.type] ||
		CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence]
	);
}

function collapseWhitespace(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

export const findingDraftSchema = z
	.strictObject({
		path: z
			.string()
			.min(1)
			.describe("Reviewed file path in the current commit."),
		line: z
			.number()
			.int()
			.min(0)
			.describe("Head-side line number. Use 0 only for a file-level issue."),
		severity: z.enum(SEVERITY_VALUES),
		type: z.enum(ANNOTATION_TYPE_VALUES),
		confidence: z.enum(CONFIDENCE_VALUES),
		title: z.string().min(1).max(200).describe("A short issue title."),
		details: z
			.string()
			.max(1600)
			.describe("A concise explanation of why this is an issue."),
		category: z
			.string()
			.max(80)
			.optional()
			.describe(
				"Optional short category when obvious and helpful, such as security, correctness, data-integrity, concurrency, reliability, performance, or tests.",
			),
	})
	.transform(
		(draft): FindingDraft =>
			omitUndefined({
				path: draft.path.trim(),
				line: draft.line,
				severity: draft.severity,
				type: draft.type,
				confidence: draft.confidence,
				title: sanitizeModelAuthoredText(collapseWhitespace(draft.title)),
				details: sanitizeModelAuthoredText(collapseWhitespace(draft.details)),
				category: draft.category
					? sanitizeModelAuthoredText(collapseWhitespace(draft.category))
					: undefined,
			}) satisfies FindingDraft,
	);

export function createReviewedFileLookup(
	reviewableFiles: readonly ReviewableFile[],
): ReadonlyMap<string, ReviewableFile> {
	const lookup = new Map<string, ReviewableFile>();
	const renamedOldPathCounts = new Map<string, number>();
	for (const file of reviewableFiles) {
		lookup.set(file.path, file);
		if (file.status === "renamed" && file.oldPath !== undefined) {
			renamedOldPathCounts.set(
				file.oldPath,
				(renamedOldPathCounts.get(file.oldPath) ?? 0) + 1,
			);
		}
	}

	for (const file of reviewableFiles) {
		if (
			file.status === "renamed" &&
			file.oldPath !== undefined &&
			renamedOldPathCounts.get(file.oldPath) === 1
		) {
			lookup.set(file.oldPath, file);
		}
	}

	return lookup;
}

export function validateFindingLocation(
	draft: FindingDraft,
	reviewedFiles: ReadonlyMap<string, ReviewableFile>,
): FindingLocationResult {
	const file = reviewedFiles.get(draft.path);
	if (!file) {
		return {
			ok: false,
			reason: "unknown_file",
			message: `The file ${draft.path} is not one of the reviewed files.`,
		};
	}

	if (draft.line > 0 && !file.changedLines.includes(draft.line)) {
		return {
			ok: false,
			reason: "unchanged_line",
			message: `Line ${draft.line} is not a changed line in ${file.path}. Valid changed line ranges: ${formatLineRanges(file.changedLines) || "none"}`,
		};
	}

	return omitUndefined({
		ok: true as const,
		draft: { ...draft, path: file.path },
		note:
			draft.path === file.path
				? undefined
				: `normalized path from ${draft.path} to ${file.path}.`,
	});
}

function makeExternalId(draft: FindingDraft): string {
	const digest = createHash("sha1")
		.update(
			[
				draft.path,
				String(draft.line),
				draft.severity,
				draft.type,
				draft.title,
				draft.details,
			].join("|"),
		)
		.digest("hex");
	return `finding-${digest.slice(0, 16)}`;
}

export function finalizeFindings(
	drafts: FindingDraft[],
	minConfidence: Confidence,
): ReviewFinding[] {
	const bestByContent = new Map<string, FindingDraft>();
	for (const draft of drafts) {
		if (CONFIDENCE_RANK[draft.confidence] < CONFIDENCE_RANK[minConfidence]) {
			continue;
		}

		const contentKey = [
			draft.path,
			draft.line,
			draft.title.toLowerCase(),
			draft.details.toLowerCase(),
		].join("|");
		const existing = bestByContent.get(contentKey);
		if (!existing || compareFindingPriority(draft, existing) > 0) {
			bestByContent.set(contentKey, draft);
		}
	}

	const unique = [...bestByContent.values()];
	const concreteLocations = new Set(
		unique
			.filter((draft) => draft.type !== "CODE_SMELL")
			.map((draft) => `${draft.path}|${draft.line}`),
	);
	const collisionCounts = new Map<string, number>();
	return unique
		.filter(
			(draft) =>
				draft.type !== "CODE_SMELL" ||
				!concreteLocations.has(`${draft.path}|${draft.line}`),
		)
		.map((draft) => {
			const collisionKey = `${draft.path}|${draft.line}|${draft.type}`;
			const collisionIndex = collisionCounts.get(collisionKey) ?? 0;
			collisionCounts.set(collisionKey, collisionIndex + 1);
			return {
				...draft,
				externalId: makeExternalId(draft),
				threadKey: buildFindingThreadKey({
					path: draft.path,
					line: draft.line,
					type: draft.type,
					collisionIndex,
				}),
			};
		})
		.sort(
			(left, right) =>
				compareFindingPriority(right, left) ||
				`${left.path}:${left.line}:${left.title}`.localeCompare(
					`${right.path}:${right.line}:${right.title}`,
				),
		);
}

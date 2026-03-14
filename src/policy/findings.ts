import { createHash } from "node:crypto";

import { z } from "zod";
import type { ChangedFile } from "../git/types.ts";
import { getReviewedFilePathForVersion } from "../review/file.ts";
import type {
	Confidence,
	FindingDraft,
	ReviewFinding,
} from "../review/types.ts";
import { omitUndefined } from "../shared/object.ts";

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

function collapseWhitespace(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

export const findingDraftSchema = z
	.object({
		path: z.string().min(1),
		line: z.number().int().min(0),
		severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
		type: z.enum(["BUG", "CODE_SMELL", "VULNERABILITY"]),
		confidence: z.enum(["low", "medium", "high"]),
		title: z.string().min(1).max(200),
		details: z.string().max(1600).default(""),
		category: z.string().max(80).optional(),
	})
	.transform(
		(draft): FindingDraft =>
			omitUndefined({
				path: draft.path.trim(),
				line: draft.line,
				severity: draft.severity,
				type: draft.type,
				confidence: draft.confidence,
				title: collapseWhitespace(draft.title),
				details: collapseWhitespace(draft.details),
				category: draft.category
					? collapseWhitespace(draft.category)
					: undefined,
			}) satisfies FindingDraft,
	);

function meetsConfidenceThreshold(
	confidence: Confidence,
	threshold: Confidence,
): boolean {
	return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[threshold];
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
	reviewedFiles: ChangedFile[],
	maxFindings: number,
	minConfidence: Confidence,
): ReviewFinding[] {
	const fileMap = new Map<string, ChangedFile>(
		reviewedFiles.map((file) => [file.path, file]),
	);
	for (const file of reviewedFiles) {
		if (file.oldPath) {
			fileMap.set(file.oldPath, file);
		}
	}
	const seen = new Set<string>();
	const accepted: ReviewFinding[] = [];

	for (const rawDraft of drafts) {
		const parsed = findingDraftSchema.safeParse(rawDraft);
		if (!parsed.success) {
			continue;
		}

		const draft = parsed.data;
		const file = fileMap.get(draft.path);
		if (!file) {
			continue;
		}

		const normalizedPath = getReviewedFilePathForVersion(file, "head");
		const normalizedDraft =
			normalizedPath === draft.path
				? draft
				: {
						...draft,
						path: normalizedPath,
					};

		if (
			normalizedDraft.line > 0 &&
			!file.changedLines.includes(normalizedDraft.line)
		) {
			continue;
		}

		if (!meetsConfidenceThreshold(normalizedDraft.confidence, minConfidence)) {
			continue;
		}

		const dedupeKey = [
			normalizedDraft.path,
			normalizedDraft.line,
			normalizedDraft.title.toLowerCase(),
			normalizedDraft.details.toLowerCase(),
		].join("|");
		if (seen.has(dedupeKey)) {
			continue;
		}

		seen.add(dedupeKey);
		accepted.push({
			...normalizedDraft,
			externalId: makeExternalId(normalizedDraft),
		});
	}

	accepted.sort((left, right) => {
		const severityDelta =
			SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
		if (severityDelta !== 0) {
			return severityDelta;
		}

		const confidenceDelta =
			CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence];
		if (confidenceDelta !== 0) {
			return confidenceDelta;
		}

		return [left.path, String(left.line), left.title]
			.join(":")
			.localeCompare([right.path, String(right.line), right.title].join(":"));
	});

	return accepted.slice(0, maxFindings);
}

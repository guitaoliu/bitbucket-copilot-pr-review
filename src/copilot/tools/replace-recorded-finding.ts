import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";

import { findingDraftSchema } from "../../policy/findings.ts";
import type { FindingDraft } from "../../review/types.ts";
import {
	parseObjectToolArgs,
	toRejectedResult,
	validateFindingDraftLocation,
} from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

const replaceRecordedFindingArgsSchema = z
	.object({
		findingNumber: z.number().int().min(1),
		path: z.string().min(1),
		line: z.number().int().min(0),
		severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
		type: z.enum(["BUG", "CODE_SMELL", "VULNERABILITY"]),
		confidence: z.enum(["low", "medium", "high"]),
		title: z.string(),
		details: z.string(),
		category: z.string().optional(),
	})
	.strict();

export function createReplaceRecordedFindingTool(
	toolContext: ReviewToolContext,
) {
	const { drafts, reviewedFileMap } = toolContext;

	return defineTool("replace_recorded_finding", {
		description:
			"Replace an already recorded finding draft with a stronger or more accurate one.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				findingNumber: {
					type: "integer",
					minimum: 1,
					description: "1-based finding number from list_recorded_findings.",
				},
				path: {
					type: "string",
					description: "Reviewed file path in the current commit.",
				},
				line: {
					type: "integer",
					minimum: 0,
					description:
						"Head-side line number. Use 0 only for a file-level issue.",
				},
				severity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
				type: { type: "string", enum: ["BUG", "CODE_SMELL", "VULNERABILITY"] },
				confidence: { type: "string", enum: ["low", "medium", "high"] },
				title: { type: "string", description: "A short issue title." },
				details: {
					type: "string",
					description: "A concise explanation of why this is an issue.",
				},
				category: {
					type: "string",
					description:
						"Optional short category when obvious and helpful, such as security, correctness, data-integrity, concurrency, reliability, performance, or tests.",
				},
			},
			required: [
				"findingNumber",
				"path",
				"line",
				"severity",
				"type",
				"confidence",
				"title",
				"details",
			],
		},
		handler: async (args: FindingDraft & { findingNumber: number }) => {
			const parsedArgs = parseObjectToolArgs(
				args,
				replaceRecordedFindingArgsSchema,
				"Invalid replace-finding payload",
			);
			if (parsedArgs.rejection) {
				return parsedArgs.rejection;
			}
			const parsedData = parsedArgs.data;
			if (!parsedData) {
				return toRejectedResult(
					"Invalid replace-finding payload: expected an object payload.",
				);
			}

			const findingIndex = parsedData.findingNumber - 1;
			if (findingIndex < 0 || findingIndex >= drafts.length) {
				return toRejectedResult(
					`Finding ${parsedData.findingNumber} does not exist. Recorded findings: ${drafts.length}.`,
				);
			}

			const parsed = findingDraftSchema.safeParse(parsedData);
			if (!parsed.success) {
				return toRejectedResult(
					`Invalid finding payload: ${parsed.error.message}`,
				);
			}

			const draft = parsed.data;
			const location = validateFindingDraftLocation(draft, reviewedFileMap);
			if (location.error) {
				return toRejectedResult(location.error);
			}

			const normalizedDraft = location.normalizedDraft ?? draft;
			drafts[findingIndex] = normalizedDraft;
			const locationLabel =
				normalizedDraft.line > 0
					? `${normalizedDraft.path}:${normalizedDraft.line}`
					: `${normalizedDraft.path}:file`;
			return location.note
				? `Replaced finding ${parsedData.findingNumber} with ${locationLabel}; ${location.note}`
				: `Replaced finding ${parsedData.findingNumber} with ${locationLabel}.`;
		},
	});
}

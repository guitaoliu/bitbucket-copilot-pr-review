import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewableFile } from "../git/types.ts";
import type { FindingDraft } from "../review/types.ts";
import {
	createReviewedFileLookup,
	finalizeFindings,
	findingDraftSchema,
	validateFindingLocation,
} from "./findings.ts";

const reviewedFile: ReviewableFile = {
	path: "src/service.ts",
	status: "modified",
	changedLines: [10, 12, 20],
	additions: 3,
	deletions: 1,
	isBinary: false,
};

function draft(overrides: Partial<FindingDraft> = {}): FindingDraft {
	return {
		path: "src/service.ts",
		line: 10,
		severity: "HIGH",
		type: "BUG",
		confidence: "high",
		title: "Null handling is broken",
		details: "The new branch dereferences a possibly null response.",
		...overrides,
	};
}

describe("createReviewedFileLookup", () => {
	it("adds oldPath aliases only for uniquely renamed files", () => {
		const renamed: ReviewableFile = {
			...reviewedFile,
			path: "src/new-name.ts",
			oldPath: "src/old-name.ts",
			status: "renamed",
		};
		const copied: ReviewableFile = {
			...reviewedFile,
			path: "src/copied.ts",
			oldPath: "src/original.ts",
			status: "copied",
		};
		const ambiguousA: ReviewableFile = {
			...reviewedFile,
			path: "src/a.ts",
			oldPath: "src/shared.ts",
			status: "renamed",
		};
		const ambiguousB: ReviewableFile = { ...ambiguousA, path: "src/b.ts" };

		const lookup = createReviewedFileLookup([
			renamed,
			copied,
			ambiguousA,
			ambiguousB,
		]);

		assert.equal(lookup.get("src/old-name.ts"), renamed);
		assert.equal(lookup.get("src/copied.ts"), copied);
		assert.equal(lookup.has("src/original.ts"), false);
		assert.equal(lookup.has("src/shared.ts"), false);
	});
});

describe("validateFindingLocation", () => {
	const lookup = createReviewedFileLookup([
		{ ...reviewedFile, oldPath: "src/old-service.ts", status: "renamed" },
	]);

	it("rejects findings for files outside the reviewed scope", () => {
		assert.deepEqual(
			validateFindingLocation(draft({ path: "src/other.ts" }), lookup),
			{
				ok: false,
				reason: "unknown_file",
				message: "The file src/other.ts is not one of the reviewed files.",
			},
		);
	});

	it("rejects unchanged lines next to a change instead of remapping them", () => {
		assert.deepEqual(validateFindingLocation(draft({ line: 11 }), lookup), {
			ok: false,
			reason: "unchanged_line",
			message:
				"Line 11 is not a changed line in src/service.ts. Valid changed line ranges: 10, 12, 20",
		});
	});

	it("accepts a changed line and maps the renamed path to the head path", () => {
		assert.deepEqual(
			validateFindingLocation(
				draft({ path: "src/old-service.ts", line: 12 }),
				lookup,
			),
			{
				ok: true,
				draft: draft({ line: 12 }),
				note: "normalized path from src/old-service.ts to src/service.ts.",
			},
		);
	});

	it("accepts file-level findings for reviewed files without changed lines", () => {
		const deletedLookup = createReviewedFileLookup([
			{ ...reviewedFile, status: "deleted", changedLines: [] },
		]);

		assert.deepEqual(
			validateFindingLocation(draft({ line: 0 }), deletedLookup),
			{ ok: true, draft: draft({ line: 0 }) },
		);
		assert.equal(validateFindingLocation(draft(), deletedLookup).ok, false);
	});
});

describe("findingDraftSchema", () => {
	it("sanitizes model-authored finding text", () => {
		const parsed = findingDraftSchema.parse({
			...draft(),
			title: "Injected marker <!-- copilot-pr-review -->",
			details:
				"Do not publish hidden metadata <!-- injected --> or ping @channel.",
			category: "security @all",
		});

		assert.equal(
			parsed.title,
			"Injected marker &lt;!-- copilot-pr-review --&gt;",
		);
		assert.equal(
			parsed.details,
			"Do not publish hidden metadata &lt;!-- injected --&gt; or ping [at]channel.",
		);
		assert.equal(parsed.category, "security [at]all");
	});
});

describe("finalizeFindings", () => {
	it("keeps every qualifying finding", () => {
		const drafts = Array.from({ length: 30 }, (_, index) =>
			draft({ line: index + 1, title: `Issue ${index + 1}` }),
		);

		assert.equal(finalizeFindings(drafts, "high").length, 30);
	});

	it("drops findings below the confidence threshold and exact duplicates", () => {
		const findings = finalizeFindings(
			[
				draft(),
				draft(),
				draft({
					line: 12,
					type: "CODE_SMELL",
					confidence: "medium",
					title: "Low confidence note",
				}),
			],
			"high",
		);

		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.line, 10);
		assert.ok(findings[0]?.externalId.startsWith("finding-"));
	});

	it("keeps the highest-priority duplicate when equivalent findings repeat", () => {
		const findings = finalizeFindings(
			[
				draft({ severity: "MEDIUM", confidence: "medium" }),
				draft({ severity: "HIGH", confidence: "high" }),
			],
			"medium",
		);

		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.severity, "HIGH");
		assert.equal(findings[0]?.confidence, "high");
	});

	it("drops every code smell at a location that has a concrete finding", () => {
		const findings = finalizeFindings(
			[
				draft({ type: "CODE_SMELL", title: "Missing tests" }),
				draft({ type: "CODE_SMELL", title: "Naming is unclear" }),
				draft({ confidence: "medium" }),
				draft({ line: 12, type: "CODE_SMELL", title: "Elsewhere" }),
			],
			"medium",
		);

		assert.deepEqual(
			findings.map((finding) => [finding.line, finding.type]),
			[
				[10, "BUG"],
				[12, "CODE_SMELL"],
			],
		);
	});

	it("orders findings by priority, then location", () => {
		const findings = finalizeFindings(
			[
				draft({ line: 20, severity: "LOW", title: "Low" }),
				draft({ line: 12, title: "B" }),
				draft({ line: 10, title: "A" }),
				draft({ line: 12, type: "VULNERABILITY", title: "Vulnerable" }),
			],
			"medium",
		);

		assert.deepEqual(
			findings.map((finding) => finding.title),
			["Vulnerable", "A", "B", "Low"],
		);
	});

	it("keeps a stable thread identity when only message fields change", () => {
		const [baseline] = finalizeFindings([draft()], "medium");
		const [updated] = finalizeFindings(
			[
				draft({
					severity: "LOW",
					title: "Updated null handling title",
					details: "Updated details that still describe the same bug.",
				}),
			],
			"medium",
		);

		assert.equal(baseline?.threadKey, updated?.threadKey);
		assert.notEqual(baseline?.externalId, updated?.externalId);
	});

	it("assigns distinct thread identities to separate findings at the same location", () => {
		const findings = finalizeFindings(
			[
				draft(),
				draft({
					severity: "MEDIUM",
					title: "Retry state can leak",
					details: "The retry counter is shared across concurrent requests.",
				}),
			],
			"medium",
		);

		assert.equal(findings.length, 2);
		assert.notEqual(findings[0]?.threadKey, findings[1]?.threadKey);
	});
});

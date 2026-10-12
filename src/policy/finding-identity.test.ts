import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewableFile } from "../git/types.ts";
import {
	buildFindingIdentities,
	collectCurrentCodeKeys,
} from "./finding-identity.ts";
import type { AnnotationType, FindingDraft } from "./types.ts";

type FindingLocation = Pick<FindingDraft, "path" | "line" | "type">;

function reviewableFile(lines: Record<number, string>): ReviewableFile {
	const changedLineText = new Map(
		Object.entries(lines).map(([line, text]) => [Number(line), text]),
	);
	return {
		path: "src/app.ts",
		status: "modified",
		additions: changedLineText.size,
		deletions: 0,
		isBinary: false,
		changedLines: [...changedLineText.keys()],
		changedLineText,
	};
}

function finding(line: number, type: AnnotationType = "BUG"): FindingLocation {
	return { path: "src/app.ts", line, type };
}

function keysByLine(
	findings: FindingLocation[],
	file: ReviewableFile,
): Map<number, string> {
	return new Map(
		buildFindingIdentities(findings, [file]).map(
			({ finding: { line }, findingKey }) => [line, findingKey],
		),
	);
}

describe("buildFindingIdentities", () => {
	it("keeps each finding's key when an edit above shifts its line", () => {
		const before = keysByLine(
			[finding(10)],
			reviewableFile({ 10: "\treturn value == other;" }),
		);
		const after = keysByLine(
			[finding(11)],
			reviewableFile({ 11: "  return  value == other; " }),
		);

		assert.equal(after.get(11), before.get(10));
	});

	it("keeps repeated identical lines apart in line order whatever order the findings arrive in", () => {
		const code = "return null;";
		const before = keysByLine(
			[finding(99), finding(98)],
			reviewableFile({ 98: code, 99: code }),
		);
		const after = keysByLine(
			[finding(99), finding(100)],
			reviewableFile({ 99: code, 100: code }),
		);

		assert.notEqual(before.get(98), before.get(99));
		assert.equal(after.get(99), before.get(98));
		assert.equal(after.get(100), before.get(99));
	});

	it("gives different keys to different code, types, and file-level findings", () => {
		const file = reviewableFile({ 1: "a();", 2: "b();" });
		const keys = buildFindingIdentities(
			[finding(1), finding(2), finding(1, "VULNERABILITY"), finding(0)],
			[file],
		).map(({ findingKey }) => findingKey);

		assert.equal(new Set(keys).size, 4);
	});
});

describe("collectCurrentCodeKeys", () => {
	it("recognizes flagged code only while it is still a changed line", () => {
		const [identity] = buildFindingIdentities(
			[finding(5)],
			[reviewableFile({ 5: "risky();" })],
		);
		assert.ok(identity);

		assert.equal(
			collectCurrentCodeKeys([reviewableFile({ 40: " risky(); " })]).has(
				identity.codeKey,
			),
			true,
		);
		assert.equal(
			collectCurrentCodeKeys([reviewableFile({ 5: "safe();" })]).has(
				identity.codeKey,
			),
			false,
		);
	});
});

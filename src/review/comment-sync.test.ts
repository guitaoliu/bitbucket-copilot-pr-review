import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PullRequestComment } from "../bitbucket/types.ts";
import {
	createLoggerSpy,
	createPullRequestComment,
	TEST_BOT_NAME,
} from "../test-support/review-fixtures.ts";
import {
	applyCommentActions,
	type CommentAction,
	type FindingCommentDraft,
	planFindingCommentSync,
	planSummaryCommentSync,
	selectOwnTaggedComments,
} from "./comment-sync.ts";
import {
	formatCommentTagMarker,
	formatFindingCodeMarker,
	formatFindingKeyMarker,
} from "./markers.ts";

const tag = "copilot-pr-review";
const headCommit = "0123456789abcdef0123";
const SUPERSEDED_SUMMARY_REPLY = "Superseded by a newer review summary.";
const DUPLICATE_FINDING_REPLY =
	"Duplicate of a newer automated finding comment.";
const STALE_FINDING_REPLY =
	"This finding no longer applies as of commit `0123456789a`.";

function summary(
	id: number,
	text: string,
	overrides: Partial<PullRequestComment> = {},
): PullRequestComment {
	return createPullRequestComment({
		id,
		text: `${formatCommentTagMarker(tag)}\n${text}`,
		createdDate: id,
		...overrides,
	});
}

function finding(
	id: number,
	key: string,
	overrides: Partial<PullRequestComment> & { codeKey?: string } = {},
): PullRequestComment {
	const { codeKey = `code-${key}`, ...commentOverrides } = overrides;
	return createPullRequestComment({
		id,
		text: `${formatFindingKeyMarker(tag, key)}\n${formatFindingCodeMarker(tag, codeKey)}\nbody ${key}`,
		createdDate: id,
		...commentOverrides,
	});
}

function discussed(count = 1): Pick<PullRequestComment, "replies"> {
	return {
		replies: Array.from({ length: count }, () => ({
			authorName: "dev",
			text: "Discussion",
		})),
	};
}

function draft(key: string, text = `new body ${key}`): FindingCommentDraft {
	return {
		keys: [`key:${key}`, `thread:thread-${key}`],
		text,
		anchor: { path: "src/app.ts", line: 3 },
	};
}

function describeActions(actions: readonly CommentAction[]): string[] {
	return actions.flatMap((action) => {
		if (action.type === "create") {
			return [`create ${action.text}`];
		}
		if (action.type === "update") {
			return [`update ${action.comment.id} ${action.text}`];
		}
		if (action.type === "delete") {
			return [`delete ${action.comment.id}`];
		}
		return [
			...(action.reply === undefined
				? []
				: [`reply ${action.comment.id} ${action.reply}`]),
			`resolve ${action.comment.id}`,
		];
	});
}

function planFindings(
	comments: PullRequestComment[],
	drafts: FindingCommentDraft[],
	currentCodeKeys: string[] = [],
): string[] {
	return describeActions(
		planFindingCommentSync({
			tag,
			own: { botName: TEST_BOT_NAME, findings: comments },
			drafts,
			currentCodeKeys: new Set(currentCodeKeys),
			headCommit,
		}),
	);
}

describe("selectOwnTaggedComments", () => {
	it("returns only marker-bearing comments the bot wrote, newest first", () => {
		const { authorName: _authorName, ...anonymous } = finding(6, "b");
		const own = selectOwnTaggedComments(tag, "Review-Bot", [
			summary(1, "older summary"),
			summary(3, "newer summary"),
			finding(2, "a"),
			summary(4, "quoted summary", { authorName: "alice" }),
			finding(5, "a", { authorName: "alice" }),
			anonymous,
			createPullRequestComment({ id: 7, text: "plain bot comment" }),
			createPullRequestComment({
				id: 8,
				authorName: "alice",
				text: "plain human comment",
			}),
		]);

		assert.deepEqual(
			own.summaries.map((comment) => comment.id),
			[3, 1],
		);
		assert.deepEqual(
			own.findings.map((comment) => comment.id),
			[2],
		);
		assert.equal(own.foreignCount, 3);
	});

	it("orders comments without dates by id", () => {
		const own = selectOwnTaggedComments(tag, TEST_BOT_NAME, [
			createPullRequestComment({ id: 4, text: formatCommentTagMarker(tag) }),
			createPullRequestComment({ id: 9, text: formatCommentTagMarker(tag) }),
		]);

		assert.deepEqual(
			own.summaries.map((comment) => comment.id),
			[9, 4],
		);
	});
});

describe("planSummaryCommentSync", () => {
	const body = `${formatCommentTagMarker(tag)}\nnew summary`;

	function planSummary(
		summaries: PullRequestComment[],
		strategy: "recreate" | "update",
	): string[] {
		return describeActions(
			planSummaryCommentSync({
				own: { botName: TEST_BOT_NAME, summaries },
				body,
				strategy,
			}),
		);
	}

	for (const strategy of ["recreate", "update"] as const) {
		it(`creates the first summary with the ${strategy} strategy`, () => {
			assert.deepEqual(planSummary([], strategy), [`create ${body}`]);
		});

		it(`does nothing with the ${strategy} strategy when the newest summary already has the body`, () => {
			assert.deepEqual(planSummary([summary(2, "new summary")], strategy), []);
		});

		it(`keeps an identical newest summary and retires older ones with the ${strategy} strategy`, () => {
			assert.deepEqual(
				planSummary([summary(1, "old"), summary(2, "new summary")], strategy),
				["delete 1"],
			);
		});
	}

	it("recreates the summary and retires every previous one by its thread state", () => {
		assert.deepEqual(
			planSummary(
				[
					summary(1, "lone"),
					summary(2, "discussed", discussed(2)),
					summary(3, "resolved", { threadResolved: true, ...discussed() }),
					summary(4, "resolved alone", { threadResolved: true }),
				],
				"recreate",
			),
			[
				`create ${body}`,
				`reply 2 ${SUPERSEDED_SUMMARY_REPLY}`,
				"resolve 2",
				"delete 1",
			],
		);
	});

	it("updates the newest summary in place and retires older ones with the update strategy", () => {
		assert.deepEqual(
			planSummary(
				[
					summary(1, "oldest"),
					summary(3, "newest"),
					summary(2, "middle", discussed()),
				],
				"update",
			),
			[
				`update 3 ${body}`,
				`reply 2 ${SUPERSEDED_SUMMARY_REPLY}`,
				"resolve 2",
				"delete 1",
			],
		);
	});

	it("creates a new summary instead of editing a resolved one with the update strategy", () => {
		assert.deepEqual(
			planSummary([summary(3, "newest", { threadResolved: true })], "update"),
			[`create ${body}`],
		);
	});

	it("resolves a discussed summary without repeating an explanation the bot already posted", () => {
		assert.deepEqual(
			planSummary(
				[
					summary(1, "old", {
						replies: [
							{ authorName: "dev", text: "Question" },
							{ authorName: TEST_BOT_NAME, text: SUPERSEDED_SUMMARY_REPLY },
						],
					}),
				],
				"recreate",
			),
			[`create ${body}`, "resolve 1"],
		);
	});
});

describe("planFindingCommentSync", () => {
	it("creates an anchored comment for a draft without a matching comment", () => {
		const actions = planFindingCommentSync({
			tag,
			own: { botName: TEST_BOT_NAME, findings: [] },
			drafts: [draft("a")],
			currentCodeKeys: new Set(),
			headCommit,
		});

		assert.deepEqual(actions, [
			{
				type: "create",
				text: "new body a",
				anchor: { path: "src/app.ts", line: 3 },
			},
		]);
	});

	it("creates a top-level comment for a file-level draft", () => {
		const actions = planFindingCommentSync({
			tag,
			own: { botName: TEST_BOT_NAME, findings: [] },
			drafts: [{ keys: ["key:file"], text: "file finding" }],
			currentCodeKeys: new Set(),
			headCommit,
		});

		assert.deepEqual(actions, [{ type: "create", text: "file finding" }]);
	});

	it("updates an open matched comment only when its text changed", () => {
		const unchanged = finding(1, "a");

		assert.deepEqual(
			planFindings([unchanged], [draft("a", unchanged.text)]),
			[],
		);
		assert.deepEqual(planFindings([finding(2, "b")], [draft("b")]), [
			"update 2 new body b",
		]);
	});

	it("never updates or re-posts a finding whose thread the developer resolved", () => {
		assert.deepEqual(
			planFindings([finding(1, "a", { threadResolved: true })], [draft("a")]),
			[],
		);
	});

	it("migrates an open comment from an earlier version matched through its legacy key", () => {
		const legacy = createPullRequestComment({
			id: 4,
			text: `<!-- ${tag}:finding-thread:thread-a -->\nold body`,
		});

		assert.deepEqual(planFindings([legacy], [draft("a")]), [
			"update 4 new body a",
		]);
	});

	it("does not let a resolved comment from an earlier version claim a new finding", () => {
		const resolvedLegacy = createPullRequestComment({
			id: 4,
			text: `<!-- ${tag}:finding-thread:thread-a -->\nold body`,
			threadResolved: true,
		});

		assert.deepEqual(planFindings([resolvedLegacy], [draft("a")]), [
			"create new body a",
		]);
	});

	it("keeps the newest of several matching comments and retires the duplicates", () => {
		const legacy = createPullRequestComment({
			id: 1,
			text: `<!-- ${tag}:finding-thread:thread-a -->\nold body`,
			createdDate: 1,
		});

		assert.deepEqual(
			planFindings(
				[
					legacy,
					finding(2, "a", discussed()),
					finding(3, "a", { threadResolved: true }),
					finding(5, "a"),
					finding(4, "a"),
				],
				[draft("a")],
			),
			[
				"update 5 new body a",
				"delete 4",
				`reply 2 ${DUPLICATE_FINDING_REPLY}`,
				"resolve 2",
				"delete 1",
			],
		);
	});

	it("still retires open duplicates when the primary thread is resolved", () => {
		assert.deepEqual(
			planFindings(
				[finding(1, "a"), finding(2, "a", { threadResolved: true })],
				[draft("a")],
			),
			["delete 1"],
		);
	});

	it("leaves an unreported finding alone while its code is still in the change", () => {
		assert.deepEqual(
			planFindings(
				[finding(1, "a", { codeKey: "still-here" })],
				[],
				["still-here"],
			),
			[],
		);
	});

	it("replies to and resolves an unreported finding whose code changed, without deleting it", () => {
		assert.deepEqual(
			planFindings([finding(1, "a", { codeKey: "gone" })], [], ["other"]),
			[`reply 1 ${STALE_FINDING_REPLY}`, "resolve 1"],
		);
	});

	it("only resolves a stale finding the bot already explained in an earlier run", () => {
		assert.deepEqual(
			planFindings(
				[
					finding(1, "a", {
						codeKey: "gone",
						replies: [
							{
								authorName: TEST_BOT_NAME,
								text: "This finding no longer applies as of commit `fedcba98765`.",
							},
						],
					}),
				],
				[],
			),
			["resolve 1"],
		);
	});

	it("closes unreported open comments from earlier versions that carry no code marker", () => {
		const legacy = createPullRequestComment({
			id: 6,
			text: `<!-- ${tag}:finding:old-id -->\nold body`,
		});

		assert.deepEqual(planFindings([legacy], []), [
			`reply 6 ${STALE_FINDING_REPLY}`,
			"resolve 6",
		]);
	});

	it("leaves an unreported finding whose thread is already resolved", () => {
		assert.deepEqual(
			planFindings([finding(1, "a", { threadResolved: true })], []),
			[],
		);
	});

	it("retires duplicates of an unreported finding and keeps its newest comment", () => {
		assert.deepEqual(
			planFindings(
				[
					finding(1, "a", { codeKey: "still-here" }),
					finding(2, "a", { codeKey: "still-here" }),
				],
				[],
				["still-here"],
			),
			["delete 1"],
		);
	});

	it("plans every create and update before any retirement", () => {
		assert.deepEqual(
			planFindings(
				[finding(1, "stale"), finding(2, "a"), finding(3, "a")],
				[draft("a"), draft("b")],
			),
			[
				"update 3 new body a",
				"create new body b",
				"delete 2",
				`reply 1 ${STALE_FINDING_REPLY}`,
				"resolve 1",
			],
		);
	});
});

describe("applyCommentActions", () => {
	const comment = createPullRequestComment({ id: 7, version: 2 });

	function createWriter(calls: string[], failing: string[] = []) {
		const record = async (call: string) => {
			calls.push(call);
			if (failing.includes(call.split(" ")[0] ?? "")) {
				throw new Error(`${call} failed`);
			}
		};
		return {
			createComment: (text: string) => record(`create ${text}`),
			updateComment: (target: PullRequestComment, text: string) =>
				record(`update ${target.id} ${text}`),
			deleteComment: (target: PullRequestComment) =>
				record(`delete ${target.id}`),
			replyToComment: (target: PullRequestComment, text: string) =>
				record(`reply ${target.id} ${text}`),
			resolveThread: (target: PullRequestComment) =>
				record(`resolve ${target.id}`),
		};
	}

	it("logs retirement failures and keeps going", async () => {
		const calls: string[] = [];
		const { logger, warnMessages } = createLoggerSpy();

		await applyCommentActions(
			createWriter(calls, ["delete", "resolve"]),
			[
				{ type: "delete", comment },
				{ type: "resolve", comment, reply: "bye" },
				{ type: "create", text: "after" },
			],
			{ label: "test comment", logger },
		);

		assert.deepEqual(calls, [
			"delete 7",
			"reply 7 bye",
			"resolve 7",
			"create after",
		]);
		assert.deepEqual(warnMessages, [
			"Failed to delete test comment 7: delete 7 failed",
			"Failed to resolve test comment 7: resolve 7 failed",
		]);
	});

	it("leaves a thread open when its explanation could not be posted", async () => {
		const calls: string[] = [];
		const { logger, warnMessages } = createLoggerSpy();

		await applyCommentActions(
			createWriter(calls, ["reply"]),
			[{ type: "resolve", comment, reply: "bye" }],
			{ label: "test comment", logger },
		);

		assert.deepEqual(calls, ["reply 7 bye"]);
		assert.deepEqual(warnMessages, [
			"Failed to reply to test comment 7; leaving its thread open: reply 7 bye failed",
		]);
	});

	for (const failing of ["create", "update"]) {
		it(`stops at the first failed ${failing}`, async () => {
			const calls: string[] = [];

			await assert.rejects(
				applyCommentActions(
					createWriter(calls, [failing]),
					[
						failing === "create"
							? { type: "create", text: "x" }
							: { type: "update", comment, text: "x" },
						{ type: "delete", comment },
					],
					{ label: "test comment", logger: createLoggerSpy().logger },
				),
				new RegExp(`${failing}.* failed`),
			);
			assert.equal(calls.length, 1);
		});
	}
});

import type { PullRequestCommentsApi } from "../bitbucket/comments.ts";
import type {
	PullRequestComment,
	PullRequestCommentLocation,
} from "../bitbucket/types.ts";
import type { PullRequestCommentStrategy } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";
import { omitUndefined } from "../shared/object.ts";
import {
	type FindingCommentKey,
	isLegacyFindingCommentKey,
	isSummaryCommentText,
	parseFindingCommentIdentity,
} from "./markers.ts";

interface RetirementReply {
	/** Prefix shared by every variant of the reply, used to detect an earlier one. */
	stem: string;
	text: string;
}

const SUPERSEDED_SUMMARY_REPLY: RetirementReply = {
	stem: "Superseded by a newer review summary.",
	text: "Superseded by a newer review summary.",
};
const DUPLICATE_FINDING_REPLY: RetirementReply = {
	stem: "Duplicate of a newer automated finding comment.",
	text: "Duplicate of a newer automated finding comment.",
};
const STALE_FINDING_REPLY_STEM = "This finding no longer applies";

export interface FindingCommentDraft {
	/** Identity keys in match priority order; the first one is the current marker format. */
	keys: readonly FindingCommentKey[];
	text: string;
	anchor?: PullRequestCommentLocation;
}

export type CommentAction =
	| { type: "create"; text: string; anchor?: PullRequestCommentLocation }
	| { type: "update"; comment: PullRequestComment; text: string }
	| { type: "delete"; comment: PullRequestComment }
	/** Resolves the thread, first posting `reply` when given; a failed reply leaves the thread open. */
	| { type: "resolve"; comment: PullRequestComment; reply?: string };

export interface OwnTaggedComments {
	botName: string;
	summaries: PullRequestComment[];
	findings: PullRequestComment[];
	/** Marker-bearing comments written by someone other than the bot account. */
	foreignCount: number;
}

function isAuthoredBy(
	authorName: string | undefined,
	botName: string,
): boolean {
	return authorName?.toLowerCase() === botName.toLowerCase();
}

function sortNewestFirst(
	comments: readonly PullRequestComment[],
): PullRequestComment[] {
	return [...comments].sort(
		(left, right) =>
			(right.createdDate ?? 0) - (left.createdDate ?? 0) || right.id - left.id,
	);
}

/**
 * Selects the summary and finding comments the bot account wrote. Comments
 * that merely carry the markers, e.g. a human quoting the bot, are counted but
 * never returned, so nothing downstream can modify them.
 */
export function selectOwnTaggedComments(
	tag: string,
	botName: string,
	comments: readonly PullRequestComment[],
): OwnTaggedComments {
	const summaries: PullRequestComment[] = [];
	const findings: PullRequestComment[] = [];
	let foreignCount = 0;
	for (const comment of comments) {
		const isSummary = isSummaryCommentText(tag, comment.text);
		if (!isSummary && !parseFindingCommentIdentity(tag, comment.text)) {
			continue;
		}

		if (!isAuthoredBy(comment.authorName, botName)) {
			foreignCount += 1;
		} else if (isSummary) {
			summaries.push(comment);
		} else {
			findings.push(comment);
		}
	}

	return {
		botName,
		summaries: sortNewestFirst(summaries),
		findings: sortNewestFirst(findings),
		foreignCount,
	};
}

/**
 * Closes a thread with an explanation, skipping the reply when the bot
 * already posted one (e.g. an earlier run replied but failed to resolve).
 */
function resolveWithReply(
	comment: PullRequestComment,
	reply: RetirementReply,
	botName: string,
): CommentAction {
	const alreadyReplied = comment.replies.some(
		(existing) =>
			isAuthoredBy(existing.authorName, botName) &&
			existing.text.startsWith(reply.stem),
	);
	return omitUndefined({
		type: "resolve" as const,
		comment,
		reply: alreadyReplied ? undefined : reply.text,
	});
}

/**
 * Takes an outdated comment out of circulation without destroying discussion:
 * a lone open comment is deleted, an open thread with replies is resolved with
 * an explanation, and a resolved thread is left as the developer left it.
 */
function retireComment(
	comment: PullRequestComment,
	reply: RetirementReply,
	botName: string,
): CommentAction[] {
	if (comment.threadResolved) {
		return [];
	}

	if (comment.replies.length === 0) {
		return [{ type: "delete", comment }];
	}

	return [resolveWithReply(comment, reply, botName)];
}

export function planSummaryCommentSync(input: {
	own: Pick<OwnTaggedComments, "botName" | "summaries">;
	body: string;
	strategy: PullRequestCommentStrategy;
}): CommentAction[] {
	const { botName } = input.own;
	const summaries = sortNewestFirst(input.own.summaries);
	const retire = (comments: readonly PullRequestComment[]) =>
		comments.flatMap((comment) =>
			retireComment(comment, SUPERSEDED_SUMMARY_REPLY, botName),
		);
	const [latest, ...older] = summaries;
	if (latest?.text === input.body) {
		return retire(older);
	}

	if (latest && input.strategy === "update" && !latest.threadResolved) {
		return [
			{ type: "update", comment: latest, text: input.body },
			...retire(older),
		];
	}

	return [{ type: "create", text: input.body }, ...retire(summaries)];
}

/**
 * Reconciles the bot's finding comments with the current drafts. Matched open
 * threads are updated only when their text changed, resolved threads are never
 * reopened or re-posted, and unmatched threads are closed with a reply only
 * once the flagged code no longer exists in the change.
 */
export function planFindingCommentSync(input: {
	tag: string;
	own: Pick<OwnTaggedComments, "botName" | "findings">;
	drafts: readonly FindingCommentDraft[];
	currentCodeKeys: ReadonlySet<string>;
	headCommit: string;
}): CommentAction[] {
	const { botName } = input.own;
	const commentsByKey = new Map<FindingCommentKey, PullRequestComment[]>();
	for (const comment of input.own.findings) {
		const identity = parseFindingCommentIdentity(input.tag, comment.text);
		// A resolved comment from an earlier version keeps its line-based key
		// forever; letting it claim drafts would suppress unrelated findings.
		if (
			!identity ||
			(comment.threadResolved && isLegacyFindingCommentKey(identity.key))
		) {
			continue;
		}

		commentsByKey.set(identity.key, [
			...(commentsByKey.get(identity.key) ?? []),
			comment,
		]);
	}

	const writes: CommentAction[] = [];
	const retirements: CommentAction[] = [];
	const retireDuplicates = (duplicates: readonly PullRequestComment[]) => {
		retirements.push(
			...duplicates.flatMap((comment) =>
				retireComment(comment, DUPLICATE_FINDING_REPLY, botName),
			),
		);
	};

	for (const draft of input.drafts) {
		const [primary, ...duplicates] = sortNewestFirst(
			draft.keys.flatMap((key) => {
				const matched = commentsByKey.get(key) ?? [];
				commentsByKey.delete(key);
				return matched;
			}),
		);
		if (!primary) {
			writes.push(
				omitUndefined({
					type: "create" as const,
					text: draft.text,
					anchor: draft.anchor,
				}),
			);
		} else if (!primary.threadResolved && primary.text !== draft.text) {
			writes.push({ type: "update", comment: primary, text: draft.text });
		}
		retireDuplicates(duplicates);
	}

	const staleReply: RetirementReply = {
		stem: STALE_FINDING_REPLY_STEM,
		text: `${STALE_FINDING_REPLY_STEM} as of commit \`${input.headCommit.slice(0, 11)}\`.`,
	};
	for (const stale of commentsByKey.values()) {
		const [primary, ...duplicates] = sortNewestFirst(stale);
		const codeKey =
			primary && parseFindingCommentIdentity(input.tag, primary.text)?.codeKey;
		if (
			primary &&
			!primary.threadResolved &&
			!(codeKey && input.currentCodeKeys.has(codeKey))
		) {
			retirements.push(resolveWithReply(primary, staleReply, botName));
		}
		retireDuplicates(duplicates);
	}

	return [...writes, ...retirements];
}

type CommentWriter = Pick<
	PullRequestCommentsApi,
	| "createComment"
	| "updateComment"
	| "deleteComment"
	| "replyToComment"
	| "resolveThread"
>;

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function applyRetirementAction(
	comments: CommentWriter,
	action: Exclude<CommentAction, { type: "create" | "update" }>,
	label: string,
	logger: Logger,
): Promise<void> {
	const subject = `${label} ${action.comment.id}`;
	if (action.type === "delete") {
		try {
			logger.info(`Deleting ${subject}`);
			await comments.deleteComment(action.comment);
		} catch (error) {
			logger.warn(`Failed to delete ${subject}: ${describeError(error)}`);
		}
		return;
	}

	if (action.reply !== undefined) {
		try {
			logger.info(`Replying to ${subject}`);
			await comments.replyToComment(action.comment, action.reply);
		} catch (error) {
			logger.warn(
				`Failed to reply to ${subject}; leaving its thread open: ${describeError(error)}`,
			);
			return;
		}
	}

	try {
		logger.info(`Resolving ${subject}`);
		await comments.resolveThread(action.comment);
	} catch (error) {
		logger.warn(`Failed to resolve ${subject}: ${describeError(error)}`);
	}
}

/**
 * Runs planned actions in order. Creating or updating content must succeed;
 * retiring outdated comments is best effort and only logs failures.
 */
export async function applyCommentActions(
	comments: CommentWriter,
	actions: readonly CommentAction[],
	options: { label: string; logger: Logger },
): Promise<void> {
	const { label, logger } = options;
	for (const action of actions) {
		if (action.type === "create") {
			logger.info(`Creating ${label}`);
			await comments.createComment(action.text, action.anchor);
		} else if (action.type === "update") {
			logger.info(`Updating ${label} ${action.comment.id}`);
			await comments.updateComment(action.comment, action.text);
		} else {
			await applyRetirementAction(comments, action, label, logger);
		}
	}
}

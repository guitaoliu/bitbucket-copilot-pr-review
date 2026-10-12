import type { PullRequestCommentStrategy } from "../config/types.ts";
import { omitUndefined } from "../shared/object.ts";
import { BITBUCKET_PR_COMMENT_MAX_CHARS } from "../shared/text.ts";
import type { BitbucketRepoScope } from "./scope.ts";
import { BitbucketApiError } from "./transport.ts";
import type {
	CommentRetirement,
	PullRequestComment,
	PullRequestCommentDraft,
	RawBitbucketCommentActivity,
	RawBitbucketPagedResponse,
} from "./types.ts";

function validatePullRequestCommentText(text: string): void {
	if (text.trim().length === 0) {
		throw new Error("Pull request comment text must not be empty.");
	}

	if (text.length > BITBUCKET_PR_COMMENT_MAX_CHARS) {
		throw new Error(
			`Pull request comment text exceeds the local Bitbucket safety limit of ${BITBUCKET_PR_COMMENT_MAX_CHARS} characters (${text.length}).`,
		);
	}
}

function getCommentSortTimestamp(
	comment: Pick<PullRequestComment, "createdDate" | "updatedDate">,
): number {
	return comment.updatedDate ?? comment.createdDate ?? 0;
}

function compareNewestFirst(
	left: PullRequestComment,
	right: PullRequestComment,
): number {
	return (
		getCommentSortTimestamp(right) - getCommentSortTimestamp(left) ||
		right.version - left.version ||
		right.id - left.id
	);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isBitbucketError(
	error: unknown,
	statusCode: number,
	pattern: RegExp,
): boolean {
	return (
		error instanceof BitbucketApiError &&
		error.statusCode === statusCode &&
		pattern.test(`${error.responseBody}\n${error.message}`)
	);
}

function isDeletionBlockedByReplies(error: unknown): boolean {
	return isBitbucketError(
		error,
		409,
		/CommentDeletionException|replies which must be deleted first/i,
	);
}

function isDeletionBlockedByResolvedThread(error: unknown): boolean {
	return isBitbucketError(
		error,
		400,
		/cannot be deleted from resolved thread/i,
	);
}

function isUpdateBlockedByResolvedThread(error: unknown): boolean {
	return isBitbucketError(
		error,
		400,
		/changes cannot be made to resolved thread/i,
	);
}

export class PullRequestCommentsApi {
	private readonly scope: BitbucketRepoScope;

	constructor(scope: BitbucketRepoScope) {
		this.scope = scope;
	}

	async listComments(): Promise<PullRequestComment[]> {
		const commentsById = new Map<number, PullRequestComment>();
		let start = 0;

		while (true) {
			const payload = await this.scope.transport.requestJson<
				RawBitbucketPagedResponse<RawBitbucketCommentActivity>
			>(`${this.scope.pullRequestPath}/activities?limit=1000&start=${start}`);

			for (const activity of payload.values ?? []) {
				if (activity.action !== "COMMENTED" || !activity.comment) {
					continue;
				}

				const nextComment = omitUndefined({
					id: activity.comment.id,
					text: activity.comment.text ?? "",
					version: activity.comment.version,
					createdDate: activity.comment.createdDate ?? activity.createdDate,
					updatedDate:
						activity.comment.updatedDate ??
						activity.comment.createdDate ??
						activity.createdDate,
				}) satisfies PullRequestComment;
				const existing = commentsById.get(nextComment.id);
				if (
					!existing ||
					existing.version < nextComment.version ||
					(existing.version === nextComment.version &&
						getCommentSortTimestamp(existing) <
							getCommentSortTimestamp(nextComment))
				) {
					commentsById.set(nextComment.id, nextComment);
				}
			}

			if (payload.isLastPage === true || payload.nextPageStart === undefined) {
				break;
			}

			start = payload.nextPageStart;
		}

		return [...commentsById.values()].sort(compareNewestFirst);
	}

	private async createComment(
		text: string,
		anchor?: PullRequestCommentDraft["anchor"],
	): Promise<void> {
		validatePullRequestCommentText(text);
		await this.scope.transport.request(
			`${this.scope.pullRequestPath}/comments`,
			{
				method: "POST",
				json: omitUndefined({
					text,
					anchor: anchor
						? {
								diffType: "EFFECTIVE",
								path: anchor.path,
								line: anchor.line,
								lineType: "ADDED",
								fileType: "TO",
							}
						: undefined,
				}),
			},
		);
	}

	private async updateComment(
		comment: PullRequestComment,
		text: string,
	): Promise<void> {
		validatePullRequestCommentText(text);
		await this.scope.transport.request(
			`${this.scope.pullRequestPath}/comments/${comment.id}`,
			{ method: "PUT", json: { version: comment.version, text } },
		);
	}

	private async retireComment(
		comment: PullRequestComment,
		retirement: CommentRetirement,
	): Promise<void> {
		const { logger } = this.scope;
		const label = `${retirement.label} ${comment.id}`;
		try {
			logger.info(`Deleting ${label}`);
			await this.scope.transport.request(
				`${this.scope.pullRequestPath}/comments/${comment.id}?version=${encodeURIComponent(String(comment.version))}`,
				{ method: "DELETE" },
			);
		} catch (error) {
			if (isDeletionBlockedByResolvedThread(error)) {
				logger.debug(
					`${label} is in a resolved thread and cannot be deleted or archived; leaving it in place.`,
				);
				return;
			}

			if (!isDeletionBlockedByReplies(error)) {
				logger.warn(`Failed to delete ${label}: ${getErrorMessage(error)}`);
				return;
			}

			try {
				logger.info(`${label} has replies; archiving it instead of deleting`);
				await this.updateComment(comment, retirement.supersededText);
			} catch (archiveError) {
				logger.warn(
					`Failed to archive ${label} after delete was blocked by replies: ${getErrorMessage(archiveError)}`,
				);
			}
		}
	}

	async upsertComment(
		existing: PullRequestComment[],
		text: string,
		options: {
			strategy: PullRequestCommentStrategy;
			retirement: CommentRetirement;
		},
	): Promise<void> {
		const [latest] = existing;
		if (latest && options.strategy === "update") {
			this.scope.logger.info(
				`Updating ${options.retirement.label} ${latest.id}`,
			);
			await this.updateComment(latest, text);
			return;
		}

		this.scope.logger.info(`Creating ${options.retirement.label}`);
		await this.createComment(text);
		for (const comment of existing) {
			await this.retireComment(comment, options.retirement);
		}
	}

	async reconcileKeyedComments(
		existing: PullRequestComment[],
		drafts: PullRequestCommentDraft[],
		options: {
			keyOf: (text: string) => string | undefined;
			retirement: CommentRetirement;
		},
	): Promise<void> {
		const commentsByKey = new Map<string, PullRequestComment>();
		const duplicates: PullRequestComment[] = [];
		for (const comment of existing) {
			const key = options.keyOf(comment.text);
			if (key === undefined) {
				continue;
			}

			if (commentsByKey.has(key)) {
				duplicates.push(comment);
			} else {
				commentsByKey.set(key, comment);
			}
		}

		for (const draft of drafts) {
			const matchedKey = draft.keys.find((key) => commentsByKey.has(key));
			const matched =
				matchedKey === undefined ? undefined : commentsByKey.get(matchedKey);
			if (matchedKey !== undefined) {
				commentsByKey.delete(matchedKey);
			}

			if (
				!matched ||
				!(await this.updateUnlessResolved(
					matched,
					draft.text,
					options.retirement,
				))
			) {
				await this.createComment(draft.text, draft.anchor);
			}
		}

		for (const comment of [...duplicates, ...commentsByKey.values()]) {
			await this.retireComment(comment, options.retirement);
		}
	}

	private async updateUnlessResolved(
		comment: PullRequestComment,
		text: string,
		retirement: CommentRetirement,
	): Promise<boolean> {
		try {
			await this.updateComment(comment, text);
			return true;
		} catch (error) {
			if (!isUpdateBlockedByResolvedThread(error)) {
				throw error;
			}

			this.scope.logger.debug(
				`${retirement.label} ${comment.id} is in a resolved thread and cannot be updated; creating a replacement comment.`,
			);
			return false;
		}
	}
}

import { omitUndefined } from "../shared/object.ts";
import { BITBUCKET_PR_COMMENT_MAX_CHARS } from "../shared/text.ts";
import type { BitbucketRepoScope } from "./scope.ts";
import type {
	PullRequestComment,
	PullRequestCommentLocation,
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

function toPullRequestComment(
	activity: RawBitbucketCommentActivity,
	comment: NonNullable<RawBitbucketCommentActivity["comment"]>,
): PullRequestComment {
	return omitUndefined({
		id: comment.id,
		version: comment.version,
		text: comment.text ?? "",
		authorName: comment.author?.name,
		threadResolved: comment.threadResolved === true,
		replies: (comment.comments ?? []).map((reply) =>
			omitUndefined({ authorName: reply.author?.name, text: reply.text ?? "" }),
		),
		createdDate: comment.createdDate ?? activity.createdDate,
	}) satisfies PullRequestComment;
}

/**
 * Bitbucket Data Center pull request comment primitives. Callers decide which
 * comments to touch; this class only talks to the REST API.
 */
export class PullRequestCommentsApi {
	private readonly scope: BitbucketRepoScope;

	constructor(scope: BitbucketRepoScope) {
		this.scope = scope;
	}

	private commentPath(comment: Pick<PullRequestComment, "id">): string {
		return `${this.scope.pullRequestPath}/comments/${comment.id}`;
	}

	/** Lists comments from the activity stream, one entry per comment at its newest version. */
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

				const nextComment = toPullRequestComment(activity, activity.comment);
				const existing = commentsById.get(nextComment.id);
				if (!existing || existing.version < nextComment.version) {
					commentsById.set(nextComment.id, nextComment);
				}
			}

			if (payload.isLastPage === true || payload.nextPageStart === undefined) {
				break;
			}

			start = payload.nextPageStart;
		}

		return [...commentsById.values()];
	}

	async createComment(
		text: string,
		anchor?: PullRequestCommentLocation,
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

	async updateComment(
		comment: Pick<PullRequestComment, "id" | "version">,
		text: string,
	): Promise<void> {
		validatePullRequestCommentText(text);
		await this.scope.transport.request(this.commentPath(comment), {
			method: "PUT",
			json: { version: comment.version, text },
		});
	}

	async deleteComment(
		comment: Pick<PullRequestComment, "id" | "version">,
	): Promise<void> {
		await this.scope.transport.request(
			`${this.commentPath(comment)}?version=${encodeURIComponent(String(comment.version))}`,
			{ method: "DELETE" },
		);
	}

	async replyToComment(
		comment: Pick<PullRequestComment, "id">,
		text: string,
	): Promise<void> {
		validatePullRequestCommentText(text);
		await this.scope.transport.request(
			`${this.scope.pullRequestPath}/comments`,
			{ method: "POST", json: { text, parent: { id: comment.id } } },
		);
	}

	/**
	 * Resolves the comment's thread at its current version, since replies
	 * posted just before may have advanced the version the caller listed.
	 */
	async resolveThread(comment: Pick<PullRequestComment, "id">): Promise<void> {
		const { version } = await this.scope.transport.requestJson<{
			version: number;
		}>(this.commentPath(comment));
		await this.scope.transport.request(this.commentPath(comment), {
			method: "PUT",
			json: { version, threadResolved: true },
		});
	}
}

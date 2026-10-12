import { CliUserError } from "./errors.ts";

export interface BitbucketPullRequestLocation {
	baseUrl: string;
	projectKey: string;
	repoSlug: string;
	prId: number;
}

const LABEL = "Pull request URL";
const INVALID_PATH_MESSAGE = `${LABEL} must point to a pull request page like https://host/projects/PROJ/repos/repo/pull-requests/123.`;

export function parseBitbucketPullRequestUrl(
	pullRequestUrl: string,
): BitbucketPullRequestLocation {
	let url: URL;
	try {
		url = new URL(pullRequestUrl.trim());
	} catch {
		throw new CliUserError(`${LABEL} must be a valid absolute http(s) URL.`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new CliUserError(`${LABEL} must use http or https.`);
	}

	const segments = url.pathname
		.split("/")
		.filter((segment) => segment.length > 0);
	const projectsIndex = segments.indexOf("projects");
	const [projectKey, reposSegment, repoSlug, pullRequestsSegment, prIdSegment] =
		segments.slice(projectsIndex + 1);
	if (
		projectsIndex < 0 ||
		projectKey === undefined ||
		reposSegment !== "repos" ||
		repoSlug === undefined ||
		pullRequestsSegment !== "pull-requests" ||
		prIdSegment === undefined
	) {
		throw new CliUserError(INVALID_PATH_MESSAGE);
	}

	const prId = /^\d+$/.test(prIdSegment)
		? Number.parseInt(prIdSegment, 10)
		: Number.NaN;
	if (!Number.isSafeInteger(prId) || prId <= 0) {
		throw new CliUserError(`${LABEL} must include a numeric pull request id.`);
	}

	const prefixSegments = segments.slice(0, projectsIndex);
	const prefixPath =
		prefixSegments.length > 0 ? `/${prefixSegments.join("/")}` : "";
	return {
		baseUrl: `${url.origin}${prefixPath}`,
		projectKey,
		repoSlug,
		prId,
	};
}

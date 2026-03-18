import { omitUndefined } from "../shared/object.ts";
import type { ParsedEnvironment } from "./env.ts";
import { getRequiredEnvValueWithMessage } from "./env.ts";
import { CONFIG_FIELD_METADATA } from "./metadata.ts";
import type { BitbucketAuthConfig, ReviewerConfig } from "./types.ts";

type BitbucketMetadataKey = {
	[K in keyof typeof CONFIG_FIELD_METADATA]: (typeof CONFIG_FIELD_METADATA)[K]["path"] extends `bitbucket.${string}`
		? K
		: never;
}[keyof typeof CONFIG_FIELD_METADATA];

export interface ResolvedBitbucketRuntimeConfig {
	tls: {
		insecureSkipVerify: boolean;
	};
}

export interface ParsedBitbucketRepositoryLocation {
	baseUrl: string;
	projectKey: string;
	repoSlug: string;
	repositoryUrl: string;
}

export interface ParsedBitbucketPullRequestLocation
	extends ParsedBitbucketRepositoryLocation {
	prId: number;
	pullRequestUrl: string;
}

function getEnvFieldName(fieldKey: BitbucketMetadataKey): string {
	const field = CONFIG_FIELD_METADATA[fieldKey];
	if (!("env" in field) || field.env === undefined) {
		throw new Error(
			`Metadata field ${String(fieldKey)} does not define an env key.`,
		);
	}

	return field.env;
}

function parseUrlOrThrow(rawUrl: string, label: string): URL {
	try {
		return new URL(rawUrl.trim());
	} catch {
		throw new Error(`${label} must be a valid absolute http(s) URL.`);
	}
}

function normalizePathname(pathname: string): string {
	const normalized = pathname.replace(/\/+/g, "/").replace(/\/+$/, "");
	return normalized.length === 0 ? "/" : normalized;
}

function parsePositiveInteger(rawValue: string, label: string): number {
	if (!/^\d+$/.test(rawValue)) {
		throw new Error(`${label} must end with a numeric pull request id.`);
	}

	const parsed = Number.parseInt(rawValue, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${label} must end with a numeric pull request id.`);
	}

	return parsed;
}

function normalizeBaseUrl(url: URL, prefixSegments: readonly string[]): string {
	const prefixPath =
		prefixSegments.length > 0 ? `/${prefixSegments.join("/")}` : "";
	return `${url.origin}${prefixPath}`;
}

function parseRepositoryPathSegments(options: {
	url: URL;
	label: string;
	requirePullRequestId: boolean;
}): {
	prefixSegments: string[];
	projectKey: string;
	repoSlug: string;
	prId?: number;
} {
	const segments = normalizePathname(options.url.pathname)
		.split("/")
		.filter((segment) => segment.length > 0);
	const projectsIndex = segments.indexOf("projects");
	if (projectsIndex < 0) {
		throw new Error(
			options.requirePullRequestId
				? `${options.label} must point to a pull request page like https://host/projects/PROJ/repos/repo/pull-requests/123.`
				: `${options.label} must point to a repository page like https://host/projects/PROJ/repos/repo.`,
		);
	}

	const projectKey = segments[projectsIndex + 1];
	const reposSegment = segments[projectsIndex + 2];
	const repoSlug = segments[projectsIndex + 3];
	if (
		projectKey === undefined ||
		reposSegment !== "repos" ||
		repoSlug === undefined
	) {
		throw new Error(
			options.requirePullRequestId
				? `${options.label} must point to a pull request page like https://host/projects/PROJ/repos/repo/pull-requests/123.`
				: `${options.label} must point to a repository page like https://host/projects/PROJ/repos/repo.`,
		);
	}

	const prefixSegments = segments.slice(0, projectsIndex);
	if (!options.requirePullRequestId) {
		if (segments.length !== projectsIndex + 4) {
			throw new Error(
				`${options.label} must point to a repository page like https://host/projects/PROJ/repos/repo.`,
			);
		}

		return {
			prefixSegments,
			projectKey,
			repoSlug,
		};
	}

	const pullRequestsSegment = segments[projectsIndex + 4];
	const prIdSegment = segments[projectsIndex + 5];
	if (
		pullRequestsSegment !== "pull-requests" ||
		prIdSegment === undefined ||
		segments.length !== projectsIndex + 6
	) {
		throw new Error(
			`${options.label} must point to a pull request page like https://host/projects/PROJ/repos/repo/pull-requests/123.`,
		);
	}

	return {
		prefixSegments,
		projectKey,
		repoSlug,
		prId: parsePositiveInteger(prIdSegment, options.label),
	};
}

export function parseBitbucketRepositoryUrl(
	repositoryUrl: string,
): ParsedBitbucketRepositoryLocation {
	const url = parseUrlOrThrow(repositoryUrl, "Repository URL");
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Repository URL must use http or https.");
	}

	const parsedPath = parseRepositoryPathSegments({
		url,
		label: "Repository URL",
		requirePullRequestId: false,
	});
	const baseUrl = normalizeBaseUrl(url, parsedPath.prefixSegments);
	const normalizedRepositoryUrl = `${baseUrl}/projects/${parsedPath.projectKey}/repos/${parsedPath.repoSlug}`;

	return {
		baseUrl,
		projectKey: parsedPath.projectKey,
		repoSlug: parsedPath.repoSlug,
		repositoryUrl: normalizedRepositoryUrl,
	};
}

export function parseBitbucketPullRequestUrl(
	pullRequestUrl: string,
): ParsedBitbucketPullRequestLocation {
	const url = parseUrlOrThrow(pullRequestUrl, "Pull request URL");
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Pull request URL must use http or https.");
	}

	const parsedPath = parseRepositoryPathSegments({
		url,
		label: "Pull request URL",
		requirePullRequestId: true,
	});
	if (parsedPath.prId === undefined) {
		throw new Error("Pull request URL must include a numeric pull request id.");
	}

	const baseUrl = normalizeBaseUrl(url, parsedPath.prefixSegments);
	const repositoryUrl = `${baseUrl}/projects/${parsedPath.projectKey}/repos/${parsedPath.repoSlug}`;
	const normalizedPullRequestUrl = `${repositoryUrl}/pull-requests/${parsedPath.prId}`;

	return {
		baseUrl,
		projectKey: parsedPath.projectKey,
		repoSlug: parsedPath.repoSlug,
		prId: parsedPath.prId,
		repositoryUrl,
		pullRequestUrl: normalizedPullRequestUrl,
	};
}

export function buildBitbucketPullRequestUrl(options: {
	baseUrl: string;
	projectKey: string;
	repoSlug: string;
	prId: number;
}): string {
	const parsedRepository = parseBitbucketRepositoryUrl(
		`${options.baseUrl}/projects/${options.projectKey}/repos/${options.repoSlug}`,
	);
	return `${parsedRepository.repositoryUrl}/pull-requests/${options.prId}`;
}

export function resolveBitbucketAuth(
	env: ParsedEnvironment,
): BitbucketAuthConfig {
	if (env.BITBUCKET_AUTH_TYPE === "basic") {
		return {
			type: "basic",
			username: getRequiredEnvValueWithMessage(
				env.BITBUCKET_USERNAME,
				`${getEnvFieldName("bitbucketUsername")} is required when ${getEnvFieldName("bitbucketAuthType")}=basic.`,
			),
			password: getRequiredEnvValueWithMessage(
				env.BITBUCKET_PASSWORD,
				`${getEnvFieldName("bitbucketPassword")} is required when ${getEnvFieldName("bitbucketAuthType")}=basic.`,
			),
		};
	}

	if (env.BITBUCKET_AUTH_TYPE === "bearer") {
		return {
			type: "bearer",
			token: getRequiredEnvValueWithMessage(
				env.BITBUCKET_TOKEN,
				`${getEnvFieldName("bitbucketToken")} is required when ${getEnvFieldName("bitbucketAuthType")}=bearer.`,
			),
		};
	}

	if (env.BITBUCKET_TOKEN !== undefined) {
		return {
			type: "bearer",
			token: env.BITBUCKET_TOKEN,
		};
	}

	if (
		env.BITBUCKET_USERNAME !== undefined ||
		env.BITBUCKET_PASSWORD !== undefined
	) {
		return {
			type: "basic",
			username: getRequiredEnvValueWithMessage(
				env.BITBUCKET_USERNAME,
				`${getEnvFieldName("bitbucketUsername")} is required when using basic Bitbucket authentication.`,
			),
			password: getRequiredEnvValueWithMessage(
				env.BITBUCKET_PASSWORD,
				`${getEnvFieldName("bitbucketPassword")} is required when using basic Bitbucket authentication.`,
			),
		};
	}

	throw new Error(
		`Provide ${getEnvFieldName("bitbucketToken")} or ${getEnvFieldName("bitbucketUsername")} and ${getEnvFieldName("bitbucketPassword")} for Bitbucket authentication.`,
	);
}

export function resolveBitbucketConfig(options: {
	location: Pick<
		ReviewerConfig["bitbucket"],
		"baseUrl" | "projectKey" | "repoSlug" | "prId"
	>;
	env: ParsedEnvironment;
	runtimeConfig: ResolvedBitbucketRuntimeConfig;
	caCertPath?: string;
}): ReviewerConfig["bitbucket"] {
	return {
		baseUrl: options.location.baseUrl,
		projectKey: options.location.projectKey,
		repoSlug: options.location.repoSlug,
		prId: options.location.prId,
		auth: resolveBitbucketAuth(options.env),
		tls: omitUndefined({
			caCertPath: options.caCertPath,
			insecureSkipVerify: options.runtimeConfig.tls.insecureSkipVerify,
		}),
	};
}

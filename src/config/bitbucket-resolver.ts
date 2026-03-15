import { omitUndefined } from "../shared/object.ts";
import type { ParsedEnvironment } from "./env.ts";
import { getRequiredEnvValue, getRequiredEnvValueWithMessage } from "./env.ts";
import { CONFIG_FIELD_METADATA } from "./metadata.ts";
import type { BitbucketAuthConfig, ReviewerConfig } from "./types.ts";

type BitbucketMetadataKey = {
	[K in keyof typeof CONFIG_FIELD_METADATA]: (typeof CONFIG_FIELD_METADATA)[K]["path"] extends `bitbucket.${string}`
		? K
		: never;
}[keyof typeof CONFIG_FIELD_METADATA];

function getEnvFieldName(fieldKey: BitbucketMetadataKey): string {
	const field = CONFIG_FIELD_METADATA[fieldKey];
	if (!("env" in field) || field.env === undefined) {
		throw new Error(
			`Metadata field ${String(fieldKey)} does not define an env key.`,
		);
	}

	return field.env;
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

export interface ResolvedBitbucketRuntimeConfig {
	tls: {
		insecureSkipVerify: boolean;
	};
}

export function resolveBitbucketConfig(
	env: ParsedEnvironment,
	runtimeConfig: ResolvedBitbucketRuntimeConfig,
	options: {
		caCertPath?: string;
	},
): ReviewerConfig["bitbucket"] {
	return {
		baseUrl: getRequiredEnvValue(env, "BITBUCKET_BASE_URL"),
		projectKey: getRequiredEnvValue(env, "BITBUCKET_PROJECT_KEY"),
		repoSlug: getRequiredEnvValue(env, "BITBUCKET_REPO_SLUG"),
		prId: getRequiredEnvValue(env, "BITBUCKET_PR_ID"),
		auth: resolveBitbucketAuth(env),
		tls: omitUndefined({
			caCertPath: options.caCertPath,
			insecureSkipVerify: runtimeConfig.tls.insecureSkipVerify,
		}),
	};
}

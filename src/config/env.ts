import { createHash } from "node:crypto";

import { z } from "zod";

import { omitUndefined } from "../shared/object.ts";
import type {
	ConfigFieldEnvParser,
	ConfigFieldEnvValue,
	ConfigFieldMetadata,
	EnvConfigFieldMetadata,
} from "./metadata.ts";
import {
	CONFIG_FIELD_METADATA,
	isEnvConfigField,
	isEnvRepoOverrideField,
} from "./metadata.ts";
import { setConfigPathValue, splitConfigPath } from "./path.ts";
import { createEmptyRepoOverrides } from "./reviewer-config.ts";
import type { ReviewerConfigRepoOverrides } from "./types.ts";

const MAX_REPORT_KEY_LENGTH = 50;
const REPORT_KEY_SAFE_CHAR_PATTERN = /[^A-Za-z0-9._-]+/g;

function normalizeOptionalEnvString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function optionalEnvString() {
	return z.preprocess(normalizeOptionalEnvString, z.string().optional());
}

function toPositiveInteger(
	name: string,
	value: string,
	ctx: z.RefinementCtx,
): number {
	if (!/^\d+$/.test(value)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `${name} must be a positive integer.`,
		});
		return z.NEVER;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `${name} must be a positive integer.`,
		});
		return z.NEVER;
	}

	return parsed;
}

function buildEnvString(_name: string) {
	return optionalEnvString().transform((value): string | undefined => {
		if (value === undefined) {
			return undefined;
		}

		return value;
	});
}

function buildEnvEnum<TValues extends readonly [string, ...string[]]>(
	name: string,
	values: TValues,
) {
	return optionalEnvString().transform(
		(value, ctx): TValues[number] | undefined => {
			if (value === undefined) {
				return undefined;
			}

			if ((values as readonly string[]).includes(value)) {
				return value as TValues[number];
			}

			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `${name} must be one of: ${values.join(", ")}.`,
			});
			return z.NEVER;
		},
	);
}

function buildEnvPositiveInteger(name: string) {
	return optionalEnvString().transform((value, ctx): number | undefined => {
		if (value === undefined) {
			return undefined;
		}

		return toPositiveInteger(name, value, ctx);
	});
}

function buildEnvBoolean(name: string) {
	return optionalEnvString().transform((value, ctx): boolean | undefined => {
		if (value === undefined) {
			return undefined;
		}

		const normalized = value.toLowerCase();
		if (["1", "true", "yes", "y", "on"].includes(normalized)) {
			return true;
		}

		if (["0", "false", "no", "n", "off"].includes(normalized)) {
			return false;
		}

		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: `${name} must be a boolean value such as true/false or 1/0.`,
		});
		return z.NEVER;
	});
}

function buildEnvStringArray(name: string) {
	return optionalEnvString().transform((value, ctx): string[] | undefined => {
		if (value === undefined) {
			return undefined;
		}

		const parts = value
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		if (parts.length === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `${name} must contain at least one non-empty value when provided.`,
			});
			return z.NEVER;
		}

		return parts;
	});
}

type EnvSchemaShape<TMetadata extends Record<string, ConfigFieldMetadata>> = {
	[K in keyof TMetadata as TMetadata[K] extends {
		env: infer TEnv extends string;
		envParser: ConfigFieldEnvParser;
	}
		? TEnv
		: never]: TMetadata[K] extends {
		envParser: infer TParser extends ConfigFieldEnvParser;
	}
		? z.ZodType<ConfigFieldEnvValue<TParser>>
		: never;
};

function buildEnvValueSchema(field: EnvConfigFieldMetadata): z.ZodType {
	switch (field.envParser.kind) {
		case "string":
			return buildEnvString(field.env);
		case "enum":
			return buildEnvEnum(field.env, field.envParser.values);
		case "positiveInteger":
			return buildEnvPositiveInteger(field.env);
		case "boolean":
			return buildEnvBoolean(field.env);
		case "stringArray":
			return buildEnvStringArray(field.env);
	}

	throw new Error(`Unsupported environment parser for ${field.env}.`);
}

function createEnvSchemaShape<
	TMetadata extends Record<string, ConfigFieldMetadata>,
>(metadata: TMetadata): EnvSchemaShape<TMetadata> {
	const shape: Record<string, z.ZodType> = {};

	for (const field of Object.values(metadata)) {
		if (!isEnvConfigField(field)) {
			continue;
		}

		shape[field.env] = buildEnvValueSchema(field);
	}

	return shape as EnvSchemaShape<TMetadata>;
}

function getEnvRepoOverridePaths(): Record<string, readonly string[]> {
	return Object.values(CONFIG_FIELD_METADATA).reduce<
		Record<string, readonly string[]>
	>((paths, field) => {
		if (!isEnvRepoOverrideField(field)) {
			return paths;
		}

		paths[field.env] = splitConfigPath(field.path);
		return paths;
	}, {});
}

function requireEnvValue<T>(value: T | undefined, message: string): T {
	if (value === undefined) {
		throw new Error(message);
	}

	return value;
}

const envShape = createEnvSchemaShape(CONFIG_FIELD_METADATA);
const envRepoOverridePaths = getEnvRepoOverridePaths();

const envSchema = z.object(envShape).superRefine((env, ctx) => {
	const hasBearerToken = env.BITBUCKET_TOKEN !== undefined;
	const hasUsername = env.BITBUCKET_USERNAME !== undefined;
	const hasPassword = env.BITBUCKET_PASSWORD !== undefined;

	const addIssue = (message: string, path?: keyof typeof env): void => {
		ctx.addIssue(
			omitUndefined({
				code: z.ZodIssueCode.custom,
				message,
				path: path ? [path] : undefined,
			}),
		);
	};

	if (env.BITBUCKET_AUTH_TYPE === "basic") {
		if (!hasUsername) {
			addIssue(
				"BITBUCKET_USERNAME is required when BITBUCKET_AUTH_TYPE=basic.",
				"BITBUCKET_USERNAME",
			);
		}
		if (!hasPassword) {
			addIssue(
				"BITBUCKET_PASSWORD is required when BITBUCKET_AUTH_TYPE=basic.",
				"BITBUCKET_PASSWORD",
			);
		}
		return;
	}

	if (env.BITBUCKET_AUTH_TYPE === "bearer") {
		if (!hasBearerToken) {
			addIssue(
				"BITBUCKET_TOKEN is required when BITBUCKET_AUTH_TYPE=bearer.",
				"BITBUCKET_TOKEN",
			);
		}
		return;
	}

	if (hasBearerToken) {
		return;
	}

	if (hasUsername || hasPassword) {
		if (!hasUsername) {
			addIssue(
				"BITBUCKET_USERNAME is required when using basic Bitbucket authentication.",
				"BITBUCKET_USERNAME",
			);
		}
		if (!hasPassword) {
			addIssue(
				"BITBUCKET_PASSWORD is required when using basic Bitbucket authentication.",
				"BITBUCKET_PASSWORD",
			);
		}
		return;
	}

	addIssue(
		"Provide BITBUCKET_TOKEN or BITBUCKET_USERNAME and BITBUCKET_PASSWORD for Bitbucket authentication.",
	);
});

export type ParsedEnvironment = z.output<typeof envSchema>;

export function normalizeReportKey(reportKey: string): string {
	const sanitized = reportKey
		.trim()
		.replace(REPORT_KEY_SAFE_CHAR_PATTERN, "-")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");

	if (sanitized.length === 0) {
		return "copilot-pr-review";
	}

	if (sanitized.length <= MAX_REPORT_KEY_LENGTH) {
		return sanitized;
	}

	const digest = createHash("sha1")
		.update(sanitized)
		.digest("hex")
		.slice(0, 10);
	const suffix = `-${digest}`;
	const prefixLength = Math.max(1, MAX_REPORT_KEY_LENGTH - suffix.length);
	return `${sanitized.slice(0, prefixLength)}${suffix}`;
}

export function getEnvRepoOverrides(
	parsedEnv: ParsedEnvironment,
): ReviewerConfigRepoOverrides {
	const overrides = createEmptyRepoOverrides();

	for (const [envName, path] of Object.entries(envRepoOverridePaths)) {
		const value = parsedEnv[envName as keyof ParsedEnvironment];
		if (value === undefined) {
			continue;
		}

		setConfigPathValue(overrides, path, value);
	}

	return overrides;
}

function formatEnvironmentError(error: z.ZodError): string {
	return error.issues.map((issue) => issue.message).join("\n");
}

export function getRequiredEnvValue<TKey extends keyof ParsedEnvironment>(
	env: ParsedEnvironment,
	key: TKey,
): Exclude<ParsedEnvironment[TKey], undefined> {
	const field = CONFIG_FIELD_METADATA[keyToMetadataKey(key)];
	if (!isEnvConfigField(field)) {
		throw new Error(
			`Metadata registered for environment key ${String(key)} is incomplete.`,
		);
	}

	return requireEnvValue(env[key], `${field.env} is required.`) as Exclude<
		ParsedEnvironment[TKey],
		undefined
	>;
}

export function getRequiredEnvValueWithMessage<T>(
	value: T | undefined,
	message: string,
): T {
	return requireEnvValue(value, message);
}

function keyToMetadataKey(
	key: keyof ParsedEnvironment,
): keyof typeof CONFIG_FIELD_METADATA {
	const entry = Object.entries(CONFIG_FIELD_METADATA).find(
		([, field]) => "env" in field && field.env === key,
	);
	if (!entry) {
		throw new Error(
			`No metadata registered for environment key ${String(key)}.`,
		);
	}

	return entry[0] as keyof typeof CONFIG_FIELD_METADATA;
}

export function parseEnvironment(env: NodeJS.ProcessEnv): ParsedEnvironment {
	const result = envSchema.safeParse(env);
	if (result.success) {
		return result.data;
	}

	throw new Error(formatEnvironmentError(result.error));
}

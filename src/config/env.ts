import { z } from "zod";

import { CliUserError } from "./errors.ts";
import type { EnvParser } from "./metadata.ts";
import { ENV_VARIABLES } from "./metadata.ts";
import type { BitbucketAuthConfig } from "./types.ts";

type EnvName = keyof typeof ENV_VARIABLES;

type EnvValue<TParser extends EnvParser> = TParser extends {
	kind: "enum";
	values: infer TValues extends readonly string[];
}
	? TValues[number]
	: TParser extends { kind: "positiveInteger" }
		? number
		: TParser extends { kind: "boolean" }
			? boolean
			: TParser extends { kind: "stringArray" }
				? string[]
				: string;

type EnvShape = {
	[K in EnvName]: z.ZodType<
		EnvValue<(typeof ENV_VARIABLES)[K]["parser"]> | undefined,
		string | undefined
	>;
};

type AddIssue = (message: string) => typeof z.NEVER;

const TRUE_VALUES = ["1", "true", "yes", "y", "on"];
const FALSE_VALUES = ["0", "false", "no", "n", "off"];

function parseHost(name: string, value: string, addIssue: AddIssue): string {
	let parsed: URL;
	try {
		parsed = new URL(value.includes("://") ? value : `https://${value}`);
	} catch {
		return addIssue(
			`${name} must be a hostname like github.com or mycompany.ghe.com.`,
		);
	}

	if (
		value.includes("://") &&
		parsed.protocol !== "http:" &&
		parsed.protocol !== "https:"
	) {
		return addIssue(`${name} must use http or https when provided as a URL.`);
	}

	if (
		parsed.host.length === 0 ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		(parsed.pathname !== "" && parsed.pathname !== "/") ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0
	) {
		return addIssue(
			`${name} must be a hostname like github.com or mycompany.ghe.com, without any path, query, or hash.`,
		);
	}

	return parsed.host;
}

function parsePositiveInteger(
	name: string,
	value: string,
	addIssue: AddIssue,
): number {
	const parsed = /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		return addIssue(`${name} must be a positive integer.`);
	}

	return parsed;
}

function parseBoolean(
	name: string,
	value: string,
	addIssue: AddIssue,
): boolean {
	const normalized = value.toLowerCase();
	if (TRUE_VALUES.includes(normalized)) {
		return true;
	}

	if (FALSE_VALUES.includes(normalized)) {
		return false;
	}

	return addIssue(`${name} must be a boolean value such as true/false or 1/0.`);
}

function parseEnvValue(
	name: string,
	parser: EnvParser,
	value: string,
	addIssue: AddIssue,
): unknown {
	switch (parser.kind) {
		case "string":
			return value;
		case "host":
			return parseHost(name, value, addIssue);
		case "enum":
			return parser.values.includes(value)
				? value
				: addIssue(`${name} must be one of: ${parser.values.join(", ")}.`);
		case "positiveInteger":
			return parsePositiveInteger(name, value, addIssue);
		case "boolean":
			return parseBoolean(name, value, addIssue);
		case "stringArray":
			return value
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0);
	}
}

const envShape = Object.fromEntries(
	Object.entries(ENV_VARIABLES).map(([name, variable]) => [
		name,
		z
			.string()
			.optional()
			.transform((raw, ctx) => {
				const value = raw?.trim();
				if (value === undefined || value.length === 0) {
					return undefined;
				}

				return parseEnvValue(name, variable.parser, value, (message) => {
					ctx.addIssue({ code: "custom", message });
					return z.NEVER;
				});
			}),
	]),
) as unknown as EnvShape;

function resolveBitbucketAuth(
	credentials: {
		authType: "basic" | "bearer" | undefined;
		token: string | undefined;
		username: string | undefined;
		password: string | undefined;
	},
	addIssue: AddIssue,
): BitbucketAuthConfig {
	const { authType, token, username, password } = credentials;
	const inferredType =
		token !== undefined
			? "bearer"
			: username !== undefined || password !== undefined
				? "basic"
				: undefined;
	const type = authType ?? inferredType;
	if (type === undefined) {
		return addIssue(
			"Provide BITBUCKET_TOKEN or BITBUCKET_USERNAME and BITBUCKET_PASSWORD for Bitbucket authentication.",
		);
	}

	const requirement =
		authType === undefined
			? "when using basic Bitbucket authentication"
			: `when BITBUCKET_AUTH_TYPE=${authType}`;
	if (type === "bearer") {
		return token !== undefined
			? { type, token }
			: addIssue(`BITBUCKET_TOKEN is required ${requirement}.`);
	}

	if (username === undefined) {
		addIssue(`BITBUCKET_USERNAME is required ${requirement}.`);
	}
	if (password === undefined) {
		addIssue(`BITBUCKET_PASSWORD is required ${requirement}.`);
	}

	return username !== undefined && password !== undefined
		? { type, username, password }
		: z.NEVER;
}

const envSchema = z.object(envShape).transform((env, ctx) => {
	const {
		BITBUCKET_AUTH_TYPE: authType,
		BITBUCKET_TOKEN: token,
		BITBUCKET_USERNAME: username,
		BITBUCKET_PASSWORD: password,
		...settings
	} = env;
	const auth = resolveBitbucketAuth(
		{ authType, token, username, password },
		(message) => {
			ctx.addIssue({ code: "custom", message });
			return z.NEVER;
		},
	);

	return { ...settings, auth };
});

export type ParsedEnvironment = z.output<typeof envSchema>;

export function parseEnvironment(env: NodeJS.ProcessEnv): ParsedEnvironment {
	const result = envSchema.safeParse(env);
	if (result.success) {
		return result.data;
	}

	throw new CliUserError(
		result.error.issues.map((issue) => issue.message).join("\n"),
	);
}

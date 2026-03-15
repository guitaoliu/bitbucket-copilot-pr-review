import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

import type { CliOptions } from "./args.ts";
import { REVIEWER_CONFIG_DEFAULTS } from "./defaults.ts";
import type { ParsedEnvironment } from "./env.ts";
import { normalizeReportKey } from "./env.ts";
import { CONFIG_FIELD_METADATA } from "./metadata.ts";
import {
	getConfigPathValue,
	setConfigPathValue,
	splitConfigPath,
} from "./path.ts";
import type { ReviewerConfig } from "./types.ts";

type RuntimeGroup = "bitbucket" | "copilot" | "report" | "review";
type RuntimeCliFlag = "dryRun" | "forceReview" | "confirmRerun";
type RuntimeMetadataKey = keyof typeof CONFIG_FIELD_METADATA;
type RuntimeTopLevelKey =
	| "repoRoot"
	| "gitRemoteName"
	| "logLevel"
	| "ciSummaryPath";
type RuntimeEnvFieldKey = {
	[K in keyof typeof CONFIG_FIELD_METADATA]: (typeof CONFIG_FIELD_METADATA)[K] extends {
		env: string;
	}
		? K
		: never;
}[keyof typeof CONFIG_FIELD_METADATA];

type RuntimeValueSource =
	| {
			kind: "env";
			field: RuntimeEnvFieldKey;
	  }
	| {
			kind: "cliFlag";
			option: RuntimeCliFlag;
	  }
	| {
			kind: "default";
	  };

interface RuntimeFieldResolver {
	field: RuntimeMetadataKey;
	sources: readonly RuntimeValueSource[];
	transform?: "normalizeReportKey";
}

type RuntimeTopLevelResolvers = {
	[K in RuntimeTopLevelKey]: (
		parsedEnv: ParsedEnvironment,
		cliOptions: CliOptions,
	) => ReviewerConfig[K];
};

function envSource(field: RuntimeEnvFieldKey): RuntimeValueSource {
	return { kind: "env", field };
}

function cliFlagSource(option: RuntimeCliFlag): RuntimeValueSource {
	return { kind: "cliFlag", option };
}

function defaultSource(): RuntimeValueSource {
	return { kind: "default" };
}

function runtimeFieldResolver(
	field: RuntimeMetadataKey,
	sources: readonly RuntimeValueSource[],
	options: {
		transform?: RuntimeFieldResolver["transform"];
	} = {},
): RuntimeFieldResolver {
	if (options.transform !== undefined) {
		return {
			field,
			sources,
			transform: options.transform,
		};
	}

	return {
		field,
		sources,
	};
}

const RUNTIME_FIELD_RESOLVERS = [
	runtimeFieldResolver("bitbucketInsecureTls", [
		envSource("bitbucketInsecureTls"),
		defaultSource(),
	]),
	runtimeFieldResolver("copilotModel", [
		envSource("copilotModel"),
		defaultSource(),
	]),
	runtimeFieldResolver("copilotGithubToken", [
		envSource("copilotGithubToken"),
		envSource("ghToken"),
		envSource("githubToken"),
	]),
	runtimeFieldResolver("copilotReasoningEffort", [
		envSource("copilotReasoningEffort"),
		defaultSource(),
	]),
	runtimeFieldResolver("copilotTimeoutMs", [
		envSource("copilotTimeoutMs"),
		defaultSource(),
	]),
	runtimeFieldResolver("reportKey", [envSource("reportKey"), defaultSource()], {
		transform: "normalizeReportKey",
	}),
	runtimeFieldResolver("reportTitle", [
		envSource("reportTitle"),
		defaultSource(),
	]),
	runtimeFieldResolver("reporterName", [
		envSource("reporterName"),
		defaultSource(),
	]),
	runtimeFieldResolver("reportCommentTag", [
		envSource("reportCommentTag"),
		defaultSource(),
	]),
	runtimeFieldResolver("reportCommentStrategy", [
		envSource("reportCommentStrategy"),
		defaultSource(),
	]),
	runtimeFieldResolver("reportLink", [
		envSource("reportLink"),
		envSource("buildUrl"),
	]),
	runtimeFieldResolver("reviewDryRun", [
		cliFlagSource("dryRun"),
		defaultSource(),
	]),
	runtimeFieldResolver("reviewForce", [
		cliFlagSource("forceReview"),
		envSource("reviewForce"),
		defaultSource(),
	]),
	runtimeFieldResolver("reviewConfirmRerun", [
		cliFlagSource("confirmRerun"),
		defaultSource(),
	]),
	runtimeFieldResolver("reviewMaxFiles", [
		envSource("reviewMaxFiles"),
		defaultSource(),
	]),
	runtimeFieldResolver("reviewMaxFindings", [
		envSource("reviewMaxFindings"),
		defaultSource(),
	]),
	runtimeFieldResolver("reviewMinConfidence", [
		envSource("reviewMinConfidence"),
		defaultSource(),
	]),
	runtimeFieldResolver("reviewMaxPatchChars", [
		envSource("reviewMaxPatchChars"),
		defaultSource(),
	]),
	runtimeFieldResolver("reviewDefaultFileSliceLines", [
		envSource("reviewDefaultFileSliceLines"),
		defaultSource(),
	]),
	runtimeFieldResolver("reviewMaxFileSliceLines", [
		envSource("reviewMaxFileSliceLines"),
		defaultSource(),
	]),
	runtimeFieldResolver("reviewIgnorePaths", [
		envSource("reviewIgnorePaths"),
		defaultSource(),
	]),
] as const satisfies readonly RuntimeFieldResolver[];

const TOP_LEVEL_RUNTIME_RESOLVERS: RuntimeTopLevelResolvers = {
	repoRoot: (parsedEnv, cliOptions) =>
		resolveRepoRoot(cliOptions.repoRoot, parsedEnv.REPO_ROOT),
	gitRemoteName: (parsedEnv) =>
		parsedEnv.GIT_REMOTE_NAME ?? REVIEWER_CONFIG_DEFAULTS.gitRemoteName,
	logLevel: (parsedEnv) =>
		parsedEnv.LOG_LEVEL ?? REVIEWER_CONFIG_DEFAULTS.logLevel,
	ciSummaryPath: (parsedEnv) => parsedEnv.CI_SUMMARY_PATH,
};

function getDefaultValueForField(fieldKey: RuntimeMetadataKey): unknown {
	return getConfigPathValue(
		REVIEWER_CONFIG_DEFAULTS,
		splitConfigPath(CONFIG_FIELD_METADATA[fieldKey].path),
	);
}

function getEnvValue(
	parsedEnv: ParsedEnvironment,
	fieldKey: RuntimeEnvFieldKey,
): unknown {
	const field = CONFIG_FIELD_METADATA[fieldKey];
	if (!("env" in field) || field.env === undefined) {
		throw new Error(
			`Runtime env source ${String(fieldKey)} is missing an env key.`,
		);
	}

	return parsedEnv[field.env as keyof ParsedEnvironment];
}

function getSourceValue(
	parsedEnv: ParsedEnvironment,
	cliOptions: CliOptions,
	resolver: RuntimeFieldResolver,
	source: RuntimeValueSource,
): unknown {
	switch (source.kind) {
		case "env":
			return getEnvValue(parsedEnv, source.field);
		case "cliFlag":
			return cliOptions[source.option] ? true : undefined;
		case "default":
			return getDefaultValueForField(resolver.field);
	}
}

function applyTransform(
	value: unknown,
	resolver: RuntimeFieldResolver,
): unknown {
	if (resolver.transform === "normalizeReportKey") {
		if (typeof value !== "string") {
			throw new Error(
				`normalizeReportKey requires a string value for ${String(resolver.field)}.`,
			);
		}

		return normalizeReportKey(value);
	}

	return value;
}

function assertRuntimeGroupObjects(
	groups: Record<RuntimeGroup, Record<string, unknown>>,
): asserts groups is Pick<ReviewerConfig, RuntimeGroup> {
	const hasBoolean = (value: unknown): value is boolean =>
		typeof value === "boolean";
	const hasString = (value: unknown): value is string =>
		typeof value === "string";
	const hasNumber = (value: unknown): value is number =>
		typeof value === "number";
	const hasStringArray = (value: unknown): value is string[] =>
		Array.isArray(value) && value.every((entry) => typeof entry === "string");
	const bitbucketTls = groups.bitbucket.tls as
		| Record<string, unknown>
		| undefined;

	if (!hasBoolean(bitbucketTls?.insecureSkipVerify)) {
		throw new Error(
			"Runtime resolver did not produce bitbucket.tls.insecureSkipVerify.",
		);
	}

	if (
		!hasString(groups.copilot.model) ||
		!hasString(groups.copilot.reasoningEffort) ||
		!hasNumber(groups.copilot.timeoutMs)
	) {
		throw new Error(
			"Runtime resolver did not produce a complete copilot config.",
		);
	}

	if (
		!hasString(groups.report.key) ||
		!hasString(groups.report.title) ||
		!hasString(groups.report.reporter) ||
		!hasString(groups.report.commentTag) ||
		!hasString(groups.report.commentStrategy)
	) {
		throw new Error(
			"Runtime resolver did not produce a complete report config.",
		);
	}

	if (
		!hasBoolean(groups.review.dryRun) ||
		!hasBoolean(groups.review.forceReview) ||
		!hasBoolean(groups.review.confirmRerun) ||
		!hasNumber(groups.review.maxFiles) ||
		!hasNumber(groups.review.maxFindings) ||
		!hasString(groups.review.minConfidence) ||
		!hasNumber(groups.review.maxPatchChars) ||
		!hasNumber(groups.review.defaultFileSliceLines) ||
		!hasNumber(groups.review.maxFileSliceLines) ||
		!hasStringArray(groups.review.ignorePaths)
	) {
		throw new Error(
			"Runtime resolver did not produce a complete review config.",
		);
	}
}

function resolveRepoRoot(
	cliRepoRoot: string | undefined,
	envRepoRoot: string | undefined,
): string {
	const candidate = cliRepoRoot ?? envRepoRoot ?? process.cwd();
	const repoRoot = path.resolve(candidate);

	try {
		accessSync(repoRoot, fsConstants.R_OK);
	} catch {
		throw new Error(`Repository root is not readable: ${repoRoot}`);
	}

	return repoRoot;
}

function resolveTopLevelConfig(
	parsedEnv: ParsedEnvironment,
	cliOptions: CliOptions,
): Pick<
	ReviewerConfig,
	"repoRoot" | "gitRemoteName" | "logLevel" | "ciSummaryPath"
> {
	const repoRoot = TOP_LEVEL_RUNTIME_RESOLVERS.repoRoot(parsedEnv, cliOptions);
	const gitRemoteName = TOP_LEVEL_RUNTIME_RESOLVERS.gitRemoteName(
		parsedEnv,
		cliOptions,
	);
	const logLevel = TOP_LEVEL_RUNTIME_RESOLVERS.logLevel(parsedEnv, cliOptions);
	const ciSummaryPath = TOP_LEVEL_RUNTIME_RESOLVERS.ciSummaryPath(
		parsedEnv,
		cliOptions,
	);

	return {
		repoRoot,
		gitRemoteName,
		logLevel,
		...(ciSummaryPath !== undefined ? { ciSummaryPath } : {}),
	};
}

export function resolveRuntimeConfigGroups(
	parsedEnv: ParsedEnvironment,
	cliOptions: CliOptions,
): Pick<ReviewerConfig, "bitbucket" | "copilot" | "report" | "review"> &
	Pick<
		ReviewerConfig,
		"repoRoot" | "gitRemoteName" | "logLevel" | "ciSummaryPath"
	> {
	const groups: Record<RuntimeGroup, Record<string, unknown>> = {
		bitbucket: {},
		copilot: {},
		report: {},
		review: {},
	};

	for (const resolver of RUNTIME_FIELD_RESOLVERS) {
		let resolvedValue: unknown;

		for (const source of resolver.sources) {
			const value = getSourceValue(parsedEnv, cliOptions, resolver, source);
			if (value !== undefined) {
				resolvedValue = applyTransform(value, resolver);
				break;
			}
		}

		if (resolvedValue === undefined) {
			continue;
		}

		const pathSegments = splitConfigPath(
			CONFIG_FIELD_METADATA[resolver.field].path,
		);
		const [group, ...nestedPath] = pathSegments;
		if (
			group === undefined ||
			(group !== "bitbucket" &&
				group !== "copilot" &&
				group !== "report" &&
				group !== "review")
		) {
			throw new Error(
				`Runtime resolver field ${String(resolver.field)} must target bitbucket, copilot, report, or review.`,
			);
		}

		setConfigPathValue(groups[group], nestedPath, resolvedValue);
	}

	assertRuntimeGroupObjects(groups);

	return {
		...resolveTopLevelConfig(parsedEnv, cliOptions),
		bitbucket: groups.bitbucket,
		copilot: groups.copilot,
		report: groups.report,
		review: groups.review,
	};
}

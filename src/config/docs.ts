import { REVIEWER_CONFIG_DEFAULTS } from "./defaults.ts";
import type {
	CliCommandMetadata,
	CliOptionMetadata,
	ConfigFieldMetadata,
} from "./metadata.ts";
import {
	BATCH_CLI_OPTION_METADATA,
	CLI_COMMAND_METADATA,
	CONFIG_FIELD_METADATA,
	isEnvConfigField,
	REVIEW_CLI_OPTION_METADATA,
} from "./metadata.ts";
import { getConfigPathValue } from "./path.ts";

function formatDefaultValue(value: unknown): string {
	if (Array.isArray(value)) {
		return value.length === 0 ? "[]" : `\`${value.join(", ")}\``;
	}

	if (typeof value === "string") {
		return `\`${value}\``;
	}

	if (typeof value === "boolean" || typeof value === "number") {
		return `\`${String(value)}\``;
	}

	return "-";
}

function getDefaultValueByPath(pathSegments: readonly string[]): unknown {
	return getConfigPathValue(REVIEWER_CONFIG_DEFAULTS, pathSegments);
}

function formatFieldDefault(field: ConfigFieldMetadata): string {
	if (field.docs?.defaultText !== undefined) {
		return field.docs.defaultText;
	}

	if (field.docs?.defaultValuePath !== undefined) {
		return formatDefaultValue(
			getDefaultValueByPath(field.docs.defaultValuePath),
		);
	}

	return "-";
}

function hasDocs(field: ConfigFieldMetadata): field is ConfigFieldMetadata & {
	docs: NonNullable<ConfigFieldMetadata["docs"]>;
} {
	return field.docs !== undefined;
}

function getDocumentedEnvFields(): ConfigFieldMetadata[] {
	return Object.values(CONFIG_FIELD_METADATA)
		.filter((field) => isEnvConfigField(field) && hasDocs(field))
		.sort((left, right) => (left.docs?.order ?? 0) - (right.docs?.order ?? 0));
}

function buildEnvRows(): string[] {
	return getDocumentedEnvFields().map((field) => {
		const envName = field.env ?? "-";
		const defaultValue = formatFieldDefault(field);
		return `| \`${envName}\` | ${defaultValue} | ${field.description} |`;
	});
}

function buildCliRows(options: readonly CliOptionMetadata[]): string[] {
	return options.map((option: CliOptionMetadata) => {
		const flags = option.flags
			.map((flag: string) =>
				option.valueLabel && flag === option.flags[0]
					? `\`${flag} ${option.valueLabel}\``
					: `\`${flag}\``,
			)
			.join(", ");
		return `| ${flags} | ${option.description} |`;
	});
}

function buildCommandSection(options: {
	heading: string;
	command: CliCommandMetadata;
	cliOptions: readonly CliOptionMetadata[];
}): string[] {
	return [
		options.heading,
		"",
		options.command.description,
		"",
		`Usage: \`bitbucket-copilot-pr-review ${options.command.usage}\``,
		"",
		"| Option | Description |",
		"| --- | --- |",
		...buildCliRows(options.cliOptions),
		...(options.command.argumentDescription
			? [
					"",
					`Argument: \`${options.command.argumentLabel}\``,
					"",
					options.command.argumentDescription,
				]
			: []),
	];
}

export function buildConfigReferenceMarkdown(): string {
	return [
		"## Configuration Reference",
		"",
		...buildCommandSection({
			heading: "### Review command",
			command: CLI_COMMAND_METADATA.review,
			cliOptions: Object.values(REVIEW_CLI_OPTION_METADATA),
		}),
		"",
		...buildCommandSection({
			heading: "### Batch command",
			command: CLI_COMMAND_METADATA.batch,
			cliOptions: Object.values(BATCH_CLI_OPTION_METADATA),
		}),
		"",
		"### Environment variables",
		"",
		"| Variable | Default | Description |",
		"| --- | --- | --- |",
		...buildEnvRows(),
		"",
	].join("\n");
}

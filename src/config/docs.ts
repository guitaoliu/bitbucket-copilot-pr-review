import type {
	CliCommandMetadata,
	CliOptionMetadata,
	EnvDefaultValue,
	EnvVariableMetadata,
} from "./metadata.ts";
import {
	CLI_COMMAND_METADATA,
	ENV_VARIABLES,
	REVIEW_CLI_OPTION_METADATA,
} from "./metadata.ts";

function formatDefaultValue(value: EnvDefaultValue): string {
	if (Array.isArray(value)) {
		return value.length === 0 ? "[]" : `\`${value.join(", ")}\``;
	}

	return `\`${String(value)}\``;
}

function buildEnvRows(): string[] {
	return Object.entries(ENV_VARIABLES).map(
		([name, variable]: [string, EnvVariableMetadata]) => {
			const defaultText =
				"default" in variable
					? formatDefaultValue(variable.default)
					: variable.docsDefault;
			return `| \`${name}\` | ${defaultText} | ${variable.description} |`;
		},
	);
}

function buildCliRows(options: readonly CliOptionMetadata[]): string[] {
	return options.map((option) => {
		const flags = option.flags
			.map((flag) =>
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
		"### Environment variables",
		"",
		"| Variable | Default | Description |",
		"| --- | --- | --- |",
		...buildEnvRows(),
		"",
	].join("\n");
}

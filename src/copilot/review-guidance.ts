import type { AnnotationType } from "../review/types.ts";

type FindingTaxonomyRule = {
	type: AnnotationType;
	hintClause: string;
	promptDetails: string;
};

const FINDING_TAXONOMY_RULES = [
	{
		type: "BUG",
		hintClause: " for concrete defects",
		promptDetails:
			"concrete correctness, data integrity, contract, state-transition, error-handling, or performance defects that can cause wrong results, crashes, corruption, stuck behavior, or broken compatibility.",
	},
	{
		type: "VULNERABILITY",
		hintClause: " for concrete security issues",
		promptDetails:
			"concrete security defects such as auth or authz bypass, injection, secret exposure, unsafe execution, trust-boundary violations, or unintended data disclosure.",
	},
	{
		type: "CODE_SMELL",
		hintClause:
			" only for substantial merge-relevant fragility such as missing test coverage",
		promptDetails:
			"only for substantial merge-relevant fragility with concrete impact, such as missing test coverage for a meaningful behavior change or brittle logic likely to break soon. Never use it for style, naming, formatting, or preference.",
	},
] as const satisfies readonly FindingTaxonomyRule[];

function joinNaturalLanguageList(values: readonly string[]): string {
	const [first, second, ...rest] = values;
	if (first === undefined) {
		return "";
	}

	if (second === undefined) {
		return first;
	}

	if (rest.length === 0) {
		return `${first} and ${second}`;
	}

	const last = rest.pop();
	if (last === undefined) {
		return `${first} and ${second}`;
	}

	return `${[first, second, ...rest].join(", ")}, and ${last}`;
}

export const FINDING_TAXONOMY_PROMPT_LINES = FINDING_TAXONOMY_RULES.map(
	(rule) => `- ${rule.type}: ${rule.promptDetails}`,
);

export const FINDING_TAXONOMY_PREFERENCE_PROMPT_LINE =
	"- Prefer BUG or VULNERABILITY when the code is already wrong or already widens access.";

export const FINDING_TAXONOMY_HINT = `Use ${joinNaturalLanguageList(
	FINDING_TAXONOMY_RULES.map((rule) => `${rule.type}${rule.hintClause}`),
)}.`;

export const QUESTION_SHAPED_FINDING_HINT =
	"No question-shaped findings: verify or drop.";

export const QUESTION_SHAPED_FINDING_PROMPT_LINE =
	"- No question-shaped or speculative findings: verify the code path or drop the concern.";

export const TEST_COVERAGE_HINT =
	"Only treat missing tests as a standalone finding when the gap materially reduces confidence in a risky behavior change; prefer concrete BUG or VULNERABILITY findings when the code is already wrong.";

export const TEST_COVERAGE_PROMPT_LINES = [
	"- Missing or inadequate tests are reportable only when the gap materially weakens confidence in a meaningful behavior change, especially in auth, validation, persistence, or public API paths.",
	"- Do not emit a standalone test-coverage finding when a stronger concrete BUG or VULNERABILITY already captures the same root cause unless the missing coverage leaves a distinct untested risk.",
] as const;

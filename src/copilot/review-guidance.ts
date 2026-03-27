import type { AnnotationType } from "../review/types.ts";

type FindingTaxonomyRule = {
	type: AnnotationType;
	hintClause: string;
	promptDetails: string;
};

const FINDING_TAXONOMY_RULES = [
	{
		type: "BUG",
		hintClause:
			" for concrete defects introduced or materially worsened by the PR",
		promptDetails:
			"concrete correctness, data integrity, contract, state-transition, error-handling, or performance defects that can cause wrong results, crashes, corruption, stuck behavior, or broken compatibility when introduced or materially worsened by this PR.",
	},
	{
		type: "VULNERABILITY",
		hintClause:
			" for concrete security issues introduced or materially worsened by the PR",
		promptDetails:
			"concrete security defects such as auth or authz bypass, injection, secret exposure, unsafe execution, trust-boundary violations, or unintended data disclosure when introduced or materially worsened by this PR.",
	},
	{
		type: "CODE_SMELL",
		hintClause:
			" only for substantial merge-relevant fragility introduced or materially worsened by the PR, such as missing test coverage",
		promptDetails:
			"only for substantial merge-relevant fragility with concrete impact, such as missing test coverage for a meaningful behavior change or brittle logic likely to break soon, when the PR introduces or materially worsens that risk. Never use it for style, naming, formatting, or preference.",
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
	"- Prefer BUG or VULNERABILITY when the PR makes behavior wrong or widens access.";

export const FINDING_TAXONOMY_HINT = `Use ${joinNaturalLanguageList(
	FINDING_TAXONOMY_RULES.map((rule) => `${rule.type}${rule.hintClause}`),
)}.`;

export const QUESTION_SHAPED_FINDING_HINT =
	"No question-shaped findings: investigate until you can verify the concern or rule it out.";

export const QUESTION_SHAPED_FINDING_PROMPT_LINE =
	"- No question-shaped or speculative findings: investigate the code path until you can verify the concern or rule it out.";

export const TEST_COVERAGE_HINT =
	"Treat missing tests as a standalone finding when a meaningful or risky behavior change leaves important positive, negative, or edge-case behavior unvalidated, especially in auth, validation, persistence, concurrency, serialization, or public API paths. Prefer concrete BUG or VULNERABILITY findings when behavior is already wrong, but still report the coverage gap when it leaves a distinct merge risk.";

export const TEST_COVERAGE_PROMPT_LINES = [
	"- Missing or inadequate tests are reportable when a meaningful or risky behavior change leaves important positive, negative, or edge-case behavior unvalidated, especially in auth, validation, persistence, concurrency, serialization, or public API paths.",
	"- Do not emit a standalone test-coverage finding when a stronger concrete BUG or VULNERABILITY already captures the same PR-introduced or PR-worsened root cause, but do report the coverage gap when it leaves a distinct merge-relevant risk that would otherwise be easy to miss.",
] as const;

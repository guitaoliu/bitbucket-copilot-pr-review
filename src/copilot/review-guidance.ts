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
			"correctness, data integrity, contract, state-transition, error-handling, or performance defects that can cause wrong results, crashes, corruption, stuck behavior, or broken compatibility.",
	},
	{
		type: "VULNERABILITY",
		hintClause:
			" for concrete security issues introduced or materially worsened by the PR",
		promptDetails:
			"security defects such as auth/authz bypass, injection, secret exposure, unsafe execution, trust-boundary violations, or unintended data disclosure.",
	},
	{
		type: "CODE_SMELL",
		hintClause:
			" only for substantial merge-relevant fragility introduced or materially worsened by the PR",
		promptDetails:
			"only for substantial merge-relevant fragility with concrete impact, such as missing test coverage for meaningful behavior or brittle logic likely to break soon. Never use it for style, naming, formatting, or preference.",
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

export const FINDING_TAXONOMY_SCOPE_PROMPT_LINE =
	"- All findings must be PR-introduced, PR-worsened, or newly exposed on a changed path.";

export const FINDING_TAXONOMY_PREFERENCE_PROMPT_LINE =
	"- Prefer BUG or VULNERABILITY when the PR already makes behavior wrong or widens access. Use CODE_SMELL for missing tests only when the gap adds a separate merge-relevant risk beyond any concrete defect.";

export const FINDING_TAXONOMY_HINT = `Use ${joinNaturalLanguageList(
	FINDING_TAXONOMY_RULES.map((rule) => `${rule.type}${rule.hintClause}`),
)}.`;

export const QUESTION_SHAPED_FINDING_HINT =
	"No question-shaped findings: investigate until you can verify the concern or rule it out.";

export const QUESTION_SHAPED_FINDING_PROMPT_LINE =
	"- No question-shaped or speculative findings: investigate the code path until you can verify the concern or rule it out.";

export const TEST_COVERAGE_HINT =
	"Treat missing tests as a standalone finding only when a meaningful or risky behavior change leaves important positive, negative, or edge-case behavior unvalidated and that gap adds a distinct merge risk. If behavior is already wrong or access is widened, prefer BUG or VULNERABILITY instead of a standalone test-gap finding unless the missing coverage adds a separate merge-relevant risk.";

export const TEST_COVERAGE_PROMPT_LINES = [
	"- Report missing tests only when meaningful or risky behavior lacks important positive, negative, or edge-case coverage and adds distinct merge risk; prefer BUG or VULNERABILITY when behavior is already wrong or access widened.",
] as const;

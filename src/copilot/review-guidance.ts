import type { AnnotationType } from "../review/types.ts";

type FindingTaxonomyRule = {
	type: AnnotationType;
	promptDetails: string;
};

const FINDING_TAXONOMY_RULES = [
	{
		type: "BUG",
		promptDetails:
			"correctness, data integrity, contract, state-transition, error-handling, or performance defects that can cause wrong results, crashes, corruption, stuck behavior, or broken compatibility.",
	},
	{
		type: "VULNERABILITY",
		promptDetails:
			"security defects such as auth/authz bypass, injection, secret exposure, unsafe execution, trust-boundary violations, or unintended data disclosure.",
	},
	{
		type: "CODE_SMELL",
		promptDetails:
			"only for substantial merge-relevant fragility with concrete impact, such as missing test coverage for meaningful behavior or brittle logic likely to break soon. Never use it for style, naming, formatting, or preference.",
	},
] as const satisfies readonly FindingTaxonomyRule[];

export const FINDING_TAXONOMY_PROMPT_LINES = FINDING_TAXONOMY_RULES.map(
	(rule) => `- ${rule.type}: ${rule.promptDetails}`,
);

export const FINDING_TAXONOMY_SCOPE_PROMPT_LINE =
	"- All findings must be PR-introduced, PR-worsened, or newly exposed on a changed path.";

export const FINDING_TAXONOMY_PREFERENCE_PROMPT_LINE =
	"- Prefer BUG or VULNERABILITY when the PR already makes behavior wrong or widens access. Use CODE_SMELL for missing tests only when the gap adds a separate merge-relevant risk beyond any concrete defect.";

export const QUESTION_SHAPED_FINDING_PROMPT_LINE =
	"- No question-shaped or speculative findings: investigate the code path until you can verify the concern or rule it out.";

export const TEST_COVERAGE_PROMPT_LINES = [
	"- Report missing tests only when meaningful or risky behavior lacks important positive, negative, or edge-case coverage and adds distinct merge risk; prefer BUG or VULNERABILITY when behavior is already wrong or access widened.",
] as const;

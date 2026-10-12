export const SEVERITY_VALUES = ["LOW", "MEDIUM", "HIGH"] as const;

type Severity = (typeof SEVERITY_VALUES)[number];

export const ANNOTATION_TYPE_VALUES = [
	"BUG",
	"CODE_SMELL",
	"VULNERABILITY",
] as const;

export type AnnotationType = (typeof ANNOTATION_TYPE_VALUES)[number];

export const CONFIDENCE_VALUES = ["low", "medium", "high"] as const;

export type Confidence = (typeof CONFIDENCE_VALUES)[number];

export interface FindingDraft {
	path: string;
	line: number;
	severity: Severity;
	type: AnnotationType;
	confidence: Confidence;
	title: string;
	details: string;
	category?: string;
}

export interface ReviewFinding extends FindingDraft {
	externalId: string;
	threadKey: string;
}

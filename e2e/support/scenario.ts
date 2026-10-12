import { type FakeBitbucket, startFakeBitbucket } from "./fake-bitbucket.ts";
import { type FakeModel, startFakeModel } from "./fake-model.ts";
import { type ReviewCliRun, runReviewCli } from "./review-cli.ts";
import {
	createScriptedReviewer,
	type ScriptedReviewerOptions,
} from "./scripted-reviewer.ts";
import {
	createTargetRepository,
	type TargetRepository,
} from "./target-repository.ts";

export interface ReviewScenario {
	repository: TargetRepository;
	model: FakeModel;
	bitbucket: FakeBitbucket;
	review(args?: string[]): Promise<ReviewCliRun>;
	close(): Promise<void>;
}

/**
 * Starts an isolated target repository, scripted model, and fake Bitbucket
 * for one scenario, so scenarios can run in parallel without sharing state.
 */
export async function startReviewScenario(
	options: {
		reviewer?: ScriptedReviewerOptions;
		activityPageSize?: number;
	} = {},
): Promise<ReviewScenario> {
	const { reviewer, ...bitbucketOptions } = options;
	const repository = createTargetRepository();
	const model = await startFakeModel(createScriptedReviewer(reviewer));
	const bitbucket = await startFakeBitbucket(
		{
			projectKey: "PROJ",
			repoSlug: "repo",
			id: 7,
			baseCommit: repository.baseCommit,
			headCommit: repository.headCommit,
		},
		bitbucketOptions,
	);

	return {
		repository,
		model,
		bitbucket,
		review: (args) =>
			runReviewCli({
				repoRoot: repository.root,
				pullRequestUrl: bitbucket.pullRequestUrl,
				modelUrl: model.url,
				...(args ? { args } : {}),
			}),
		async close() {
			await model.close();
			await bitbucket.close();
			repository.cleanup();
		},
	};
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getPullRequestSkipReason } from "./pull-requests.ts";

describe("getPullRequestSkipReason", () => {
	it("skips draft pull requests", () => {
		const reason = getPullRequestSkipReason(
			{
				id: 123,
				draft: true,
				source: {
					displayId: "feature/add-batch-review",
				},
			} as never,
			["renovate/"],
		);

		assert.equal(
			reason,
			"Skipping review because pull request #123 is a draft.",
		);
	});

	it("skips renovate branches", () => {
		const reason = getPullRequestSkipReason(
			{
				id: 123,
				source: {
					displayId: "renovate/npm-and-pnpm-10.x",
				},
			} as never,
			["renovate/"],
		);

		assert.equal(
			reason,
			"Skipping review because pull request #123 source branch renovate/npm-and-pnpm-10.x matches skip prefix renovate/.",
		);
	});

	it("supports custom prefixes", () => {
		const reason = getPullRequestSkipReason(
			{
				id: 123,
				source: {
					displayId: "deps/npm-10",
				},
			} as never,
			["renovate/", "deps/"],
		);

		assert.equal(
			reason,
			"Skipping review because pull request #123 source branch deps/npm-10 matches skip prefix deps/.",
		);
	});

	it("allows non-renovate branches", () => {
		const reason = getPullRequestSkipReason(
			{
				id: 123,
				source: {
					displayId: "feature/add-batch-review",
				},
			} as never,
			["renovate/"],
		);

		assert.equal(reason, undefined);
	});

	it("prefers the draft skip reason over branch prefixes", () => {
		const reason = getPullRequestSkipReason(
			{
				id: 123,
				draft: true,
				source: {
					displayId: "renovate/npm-10",
				},
			} as never,
			["renovate/"],
		);

		assert.equal(
			reason,
			"Skipping review because pull request #123 is a draft.",
		);
	});

	it("allows clearing the renovate default when no skip prefixes are configured", () => {
		const reason = getPullRequestSkipReason(
			{
				id: 123,
				source: {
					displayId: "renovate/npm-10",
				},
			} as never,
			[],
		);

		assert.equal(reason, undefined);
	});

	it("uses only configured prefixes when custom prefixes are provided", () => {
		const reason = getPullRequestSkipReason(
			{
				id: 123,
				source: {
					displayId: "renovate/npm-10",
				},
			} as never,
			["deps/"],
		);

		assert.equal(reason, undefined);
	});
});

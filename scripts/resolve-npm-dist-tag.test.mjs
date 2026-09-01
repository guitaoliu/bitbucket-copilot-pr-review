import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveNpmDistTag } from "./resolve-npm-dist-tag.mjs";

describe("resolveNpmDistTag", () => {
	it("routes stable and beta versions to separate npm tags", () => {
		assert.equal(resolveNpmDistTag("1.2.3", "v1.2.3"), "latest");
		assert.equal(resolveNpmDistTag("1.2.3-beta", "v1.2.3-beta"), "beta");
		assert.equal(resolveNpmDistTag("1.2.3-beta.4", "v1.2.3-beta.4"), "beta");
	});

	it("rejects mismatched tags and unsupported prereleases", () => {
		assert.throws(
			() => resolveNpmDistTag("1.2.3", "v1.2.4"),
			/does not match package version/,
		);
		assert.throws(
			() => resolveNpmDistTag("1.2.3-rc.1", "v1.2.3-rc.1"),
			/Unsupported release version/,
		);
		assert.throws(
			() => resolveNpmDistTag("1.2.3-beta.foo", "v1.2.3-beta.foo"),
			/Unsupported release version/,
		);
		assert.throws(
			() => resolveNpmDistTag("1.2.3-beta.01", "v1.2.3-beta.01"),
			/Unsupported release version/,
		);
	});
});

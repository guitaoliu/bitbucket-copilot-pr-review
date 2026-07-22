# tsdown text imports

## Conclusion

For the exact import below, tsdown 0.22.12 does **not** need a `loader` setting:

```ts
import rawText from "./file.txt" with { type: "text" };
```

Rolldown 1.2.0, tsdown's bundler, maps `.txt` to its `Text` module type by default. The import attribute is redundant for this result: Rolldown chooses the module type from the file extension (or an explicitly configured/plugin-provided module type), not from `with { type: "text" }`.

For another extension such as `.md`, configure tsdown:

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
	loader: {
		".md": "text",
	},
});
```

## Evidence

- tsdown documents `loader?: ModuleTypes` as the setting that controls how input files are processed. Its implementation forwards `loader` entries to Rolldown's `moduleTypes` map. Sources: [tsdown `UserConfig.loader`](https://tsdown.dev/reference/api/Interface.UserConfig#loader), [tsdown v0.22.12 forwarding code](https://github.com/rolldown/tsdown/blob/v0.22.12/src/features/rolldown.ts#L262-L265).
- Rolldown documents module-type selection as extension-based and says configuration is needed when an extension is not recognized. Source: [Rolldown Module Types guide](https://rolldown.rs/in-depth/module-types).
- Rolldown v1.2.0's default table explicitly contains `("txt", ModuleType::Text)` and merges user-defined mappings afterward. Source: [default module-type table](https://github.com/rolldown/rolldown/blob/v1.2.0/crates/rolldown/src/utils/prepare_build_context.rs#L220-L245).
- Rolldown's load path selects a module type by looking up the resolved file ID's extension in that table. It does not consult import attributes for this choice. Source: [extension lookup](https://github.com/rolldown/rolldown/blob/v1.2.0/crates/rolldown/src/utils/load_source.rs#L52-L64), [lookup helper](https://github.com/rolldown/rolldown/blob/v1.2.0/crates/rolldown/src/utils/load_source.rs#L147-L158).
- Import-attribute syntax and runtime support are separate concerns. Node.js 24 parses import attributes but supports only `type: "json"`; it does not provide a native `text` module type. Its file loader also rejects unknown extensions. Sources: [Node.js import attributes](https://nodejs.org/docs/latest-v24.x/api/esm.html#import-attributes), [Node.js loader behavior](https://nodejs.org/docs/latest-v24.x/api/esm.html#resolution-and-loading-algorithm).

## Practical rule

- `.txt`: no tsdown loader config needed; omit `with { type: "text" }` because it adds no loading behavior.
- `.md`: add `loader: { ".md": "text" }`.
- Direct Node.js source execution: neither form gives Node native text imports; bundle first or read the file with `node:fs`.

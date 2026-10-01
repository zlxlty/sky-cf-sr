import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "sky-cf-sr",
		compatibilityDate: "2026-09-30",
		entrypoint,
		env: {
			WORLD: bindings.text("World"),
		},
	},
});

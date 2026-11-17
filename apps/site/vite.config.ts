import { join } from "node:path";
import { defineConfig } from "vite";
import { LANGUAGES } from "./src/languages";

// Relative asset paths, so the site works from any folder of a static host.
// Each language is its own page, rendered by scripts/render.ts.
export default defineConfig({
	base: "./",
	build: {
		rollupOptions: {
			input: Object.fromEntries(
				LANGUAGES.map((language) => [
					language.code,
					join(import.meta.dirname, language.path, "index.html"),
				]),
			),
		},
	},
	server: { port: 5174, strictPort: true },
});

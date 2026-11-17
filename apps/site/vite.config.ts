import { defineConfig } from "vite";

// Relative asset paths, so the site works from any folder of a static host.
export default defineConfig({
	base: "./",
	server: { port: 5174, strictPort: true },
});

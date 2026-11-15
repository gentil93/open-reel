import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs separately: `bun run dev:server`.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		strictPort: true,
		proxy: { "/api": "http://127.0.0.1:4096" },
	},
});

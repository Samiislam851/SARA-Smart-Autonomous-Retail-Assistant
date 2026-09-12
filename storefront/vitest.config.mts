import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// `.mts`, not `.ts`: Vite's native config loader treats a `.ts` config in a
// non-`"type": "module"` package as CommonJS and warns that the ESM syntax
// here will stop working once native loading becomes the default.
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    // jsdom for component tests; files needing the real Node runtime opt out
    // per-file with a `// @vitest-environment node` pragma (see db/client.test.ts).
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    css: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", "out/**", "build/**"],
    // Next.js loads `.env.local` for us; Vitest does not. Without this, every
    // repository integration test (features 2+) would have to remember to
    // prefix `MONGODB_URI=...` by hand. The empty prefix loads unprefixed
    // vars, not just `VITE_*` ones.
    env: loadEnv("test", process.cwd(), ""),
  },
});

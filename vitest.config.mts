import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Same "@/..." alias as tsconfig.json, so tests can import the route handler
// (app/api/extract/route.ts) and anything else that uses the alias.
export default defineConfig({
  // Component tests (lib/__tests__/entry.test.tsx) render .tsx files; tsconfig
  // keeps JSX as-is for Next, so the test transform is told to compile it.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }],
  },
  test: {
    environment: "node",
    // Test files anywhere in the project, but never the build output.
    exclude: [...configDefaults.exclude, ".next/**", "out/**"],
  },
});

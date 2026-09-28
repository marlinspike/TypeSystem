// Run from the repo root via `npm run lint` (see the root package.json).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "**/.changeset/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
      parserOptions: {
        project: "./tsconfig.lint.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      // Async methods implementing a Promise-returning interface (adapters, stores, caches, test
      // stubs) often have nothing to await; that's the intended shape here, not a bug.
      "@typescript-eslint/require-await": "off"
    }
  },
  {
    // Smoke scripts inspect arbitrary MCP JSON payloads; typing every shape would add nothing.
    files: ["scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off"
    }
  },
  {
    // Plain JS (the browser demo, this config) isn't in the lint tsconfig, so it gets syntax-only rules.
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked
  },
  {
    files: ["packages/demo-web/public/**/*.js"],
    languageOptions: { globals: { ...globals.browser } }
  }
);

import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "artifacts/**",
      "dist/**",
      "node_modules/**",
      "test-results/**",
      "packages/*/dist/**",
      "packages/*/dist-tarball/**",
      "packages/*/node_modules/**",
      "packages/panel/src/routeTree.gen.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-case-declarations": "off",
      "no-control-regex": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-undef": "off",
      "no-useless-assignment": "off",
      "no-useless-escape": "warn",
      "prefer-const": "off",
      "preserve-caught-error": "off",
      "react/no-danger": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },
  // CommonJS preloads under scripts/ (`node --require`): `require` is how they load, by design.
  {
    files: ["scripts/**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Type-aware rules (#600). Scoped to TypeScript source and tests, where a
  // tsconfig covers the file; config files, `.mjs` scripts and generated files
  // stay untyped so they never fail on a missing project.
  {
    files: ["packages/*/src/**/*.{ts,tsx}"],
    ignores: ["packages/panel/src/routeTree.gen.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs", "vite*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
);

import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
export default [
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser, parserOptions: { sourceType: "module" } },
    plugins: { "@typescript-eslint": tseslint },
    rules: { ...tseslint.configs.recommended.rules, "@typescript-eslint/no-explicit-any": "error" },
  },
];

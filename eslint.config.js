import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-non-null-assertion": "error"
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      // node:test 的 describe/it 注册函数在类型上可返回 Promise；测试运行器负责消费，
      // 强制每个声明写 void 会掩盖真正需要等待的断言。异步假对象也允许直接返回值。
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off"
    },
  },
);

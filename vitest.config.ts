import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // Redirects fileStore's on-disk artifacts to a throwaway directory so
      // running tests never writes into the real data/runs/ used by the CLI.
      DATA_DIR: path.resolve(process.cwd(), ".vitest-data"),
      // dotenv (config/env.ts) never overrides a key that already exists in
      // process.env, even if empty — setting these here BEFORE the real .env
      // loads forces every agent/tool onto its deterministic stub path during
      // tests, regardless of what real credentials happen to be in .env.
      // Without this, tests silently make real network calls (and burn real
      // API quota) whenever a developer has configured Azure/Brave locally.
      BRAVE_SEARCH_API_KEY: "",
      LLM_PROVIDER: "",
      OPENROUTER_API_KEY: "",
      AZURE_OPENAI_API_KEY: "",
      AZURE_OPENAI_ENDPOINT: "",
      AZURE_OPENAI_API_VERSION: "",
      AZURE_OPENAI_DEPLOYMENT: "",
      AZURE_OPENAI_DEPLOYMENT_LARGE: "",
    },
    server: {
      // node:sqlite is still experimental and isn't in Node's public
      // builtinModules list, which Vite's default externalization check
      // relies on — without this, Vite tries (and fails) to bundle it as a
      // regular package named "sqlite" instead of passing it through to Node.
      deps: {
        external: [/^(node:)?sqlite$/],
      },
    },
  },
});

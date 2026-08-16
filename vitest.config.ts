import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // Redirects fileStore's on-disk artifacts to a throwaway directory so
      // running tests never writes into the real data/runs/ used by the CLI.
      // The actual secret-hermeticity guarantee (every agent/tool forced onto
      // its deterministic stub path, regardless of what's in a developer's
      // real .env) lives in config/env.ts itself now — it skips loading .env
      // entirely whenever process.env.VITEST is set, rather than requiring a
      // manually-maintained list of every secret var name here.
      DATA_DIR: path.resolve(process.cwd(), ".vitest-data"),
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

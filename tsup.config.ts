import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    instrumentation: "src/instrumentation.ts",
    routes: "src/routes.ts",
    client: "src/client.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "node18",
  external: ["@supabase/supabase-js"],
});

import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out/test/suite/*.js",
  extensionDevelopmentPath: process.cwd(),
  launchArgs: ["--disable-extensions"],
});

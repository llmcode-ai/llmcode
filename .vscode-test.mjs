import { runTests } from "@vscode/test-cli";

async function main() {
  try {
    await runTests({
      extensionDevelopmentPath: process.cwd(),
      extensionTestsPath: process.cwd() + "/dist/test/runTests.js",
      launchArgs: ["--disable-extensions"],
    });
  } catch (err) {
    console.error("Failed to run tests", err);
    process.exit(1);
  }
}

main();

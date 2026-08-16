import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { chromium } from "playwright";

import { installBoundedArubaRequestGet } from "./aruba-download-limit.ts";
import { runArubaReadHelper } from "./aruba-read-helper.ts";

const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = (async (
  ...args: Parameters<typeof chromium.launchPersistentContext>
) => {
  const context = await originalLaunchPersistentContext(...args);
  installBoundedArubaRequestGet(context);
  return context;
}) as typeof chromium.launchPersistentContext;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const hubUrl = option("--hub");
const browser = option("--browser") as "chrome" | "msedge" | undefined;
if (!hubUrl || !browser || !["chrome", "msedge"].includes(browser)) {
  throw new Error("Uso: npm run aruba:sync -- --hub https://hub.example --browser chrome|msedge");
}
const input = createInterface({ input: process.stdin, output: process.stdout });
const token = (await input.question("Codice helper di sola lettura: ")).trim();
input.close();
await runArubaReadHelper({
  hubUrl,
  token,
  browser,
  profileDirectory: path.resolve(
    option("--profile") ?? path.join(os.homedir(), ".hub-fatture", "aruba-read-browser"),
  ),
});

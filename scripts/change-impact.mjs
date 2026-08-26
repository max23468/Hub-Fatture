import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DOCUMENTATION = [
  /^(?:AGENTS|CHANGELOG|CLAUDE|CONTRIBUTING|README|SECURITY)\.md$/,
  /^docs\//,
  /^\.github\//,
];

const TEST_ONLY = [
  /(?:^|\/)test(?:s)?\//,
  /\.(?:node-)?test\.mjs$/,
  /\.test\.tsx?$/,
  /^playwright\.config\.ts$/,
];

const RUNTIME = [
  /^\.dockerignore$/,
  /^\.github\/workflows\/foundation\.yml$/,
  /^app\//,
  /^src\//,
  /^migrations\//,
  /^schemas\//,
  /^(?:Dockerfile|compose(?:\.production)?\.yaml|package(?:-lock)?\.json)$/,
  /^(?:react-router|vite)\.config\.ts$/,
  /^shopify\.(?:app|web)\.toml$/,
  /^tsconfig(?:\.server)?\.json$/,
  /^ops\//,
  /^scripts\/(?:backup|monitor-local|production-|read-env|restore)\.?.*$/,
];

const KNOWN_TOOLING = [
  /^\.env\.example$/,
  /^\.github\//,
  /^\.gitignore$/,
  /^doctor\.config\.json$/,
  /^mise\.toml$/,
  /^scripts\//,
];

const matches = (file, patterns) => patterns.some((pattern) => pattern.test(file));

export function classifyFiles(inputFiles) {
  const files = [...new Set(inputFiles.map((file) => file.trim()).filter(Boolean))].sort();
  const unknown = files.filter(
    (file) =>
      !matches(file, DOCUMENTATION) &&
      !matches(file, TEST_ONLY) &&
      !matches(file, RUNTIME) &&
      !matches(file, KNOWN_TOOLING),
  );
  const failClosed = unknown.length > 0;
  const docsOnly =
    files.length > 0 &&
    files.every((file) => matches(file, DOCUMENTATION) && !matches(file, RUNTIME));
  const testsOnly =
    files.length > 0 &&
    !docsOnly &&
    files.every((file) => matches(file, DOCUMENTATION) || matches(file, TEST_ONLY));
  const runtime =
    failClosed || files.some((file) => matches(file, RUNTIME) && !matches(file, TEST_ONLY));
  const dependencies =
    failClosed ||
    files.some((file) =>
      /^(?:Dockerfile|compose(?:\.production)?\.yaml|package(?:-lock)?\.json|\.github\/(?:dependabot\.yml|workflows\/.*\.yml))$/.test(
        file,
      ),
    );
  const database = failClosed || files.some((file) => /^(?:migrations\/|src\/db\/)/.test(file));
  const auditableDependencies = files.some((file) =>
    /^(?:Dockerfile|compose(?:\.production)?\.yaml|package(?:-lock)?\.json)$/.test(file),
  );
  const securityData =
    failClosed ||
    auditableDependencies ||
    files.some((file) =>
      /(?:^|\/)(?:auth|crypto|webhook|document-storage|retention|backup|restore|production-deploy)(?:[.-]|$)|^migrations\//.test(
        file,
      ),
    );
  const provider =
    failClosed ||
    files.some((file) =>
      /^(?:shopify\.|src\/(?:aruba|email)|src\/integrations\/|app\/routes\/(?:aruba|ebay|shopify)|scripts\/(?:aruba|provider)|tests\/fixtures\/(?:aruba|connectors|fatturapa))/.test(
        file,
      ),
    );
  const arubaPlatform =
    failClosed ||
    files.some((file) =>
      /^(?:\.github\/workflows\/aruba-platform\.yml$|scripts\/(?:aruba-helper|aruba-read-helper|aruba-read-runner|aruba-download-limit)|src\/aruba(?:-inbound|-bookmarklet)?\.ts$|tests\/e2e\/aruba-synthetic|app\/routes\/aruba-(?:bridge|browser|helper|sync))/.test(
        file,
      ),
    );
  const react = failClosed || files.some((file) => /^app\/.*\.(?:css|ts|tsx)$/.test(file));
  const e2e =
    failClosed ||
    runtime ||
    files.some((file) =>
      /^(?:tests\/e2e\/|playwright\.config\.ts$|scripts\/(?:aruba-helper|aruba-read-helper|aruba-read-runner|aruba-download-limit)|src\/aruba-bookmarklet)/.test(
        file,
      ),
    );
  const image = runtime;
  const migrationStorage =
    failClosed ||
    files.some((file) =>
      /^(?:migrations\/|compose\.production\.yaml$|scripts\/(?:backup|restore)|src\/db\/(?:document-storage|migrations|retention))/.test(
        file,
      ),
    );
  const deploy =
    failClosed ||
    files.some((file) =>
      /^(?:Dockerfile$|compose\.production\.yaml$|migrations\/|ops\/|scripts\/(?:backup|monitor-local|production-|read-env|restore))/.test(
        file,
      ),
    );
  const standard = files.length > 0 && !docsOnly;
  const lane =
    files.length === 0
      ? "none"
      : docsOnly
        ? "docs"
        : deploy
          ? "deploy"
          : provider
            ? "provider"
            : securityData
              ? "security-data"
              : "standard";

  return {
    lane,
    files,
    unknown,
    docsOnly,
    testsOnly,
    standard,
    runtime,
    dependencies,
    database,
    securityData,
    provider,
    arubaPlatform,
    react,
    e2e,
    image,
    migrationStorage,
    deploy,
    failClosed,
  };
}

function changedFiles(base, head) {
  const emptyTree = execFileSync("git", ["hash-object", "-t", "tree", "/dev/null"], {
    encoding: "utf8",
  }).trim();
  const effectiveBase = /^0{40}$/.test(base) ? emptyTree : base;
  return execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "--diff-filter=ACDMRTUXB", effectiveBase, head, "--"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
}

function outputs(result) {
  const booleans = [
    "docsOnly",
    "testsOnly",
    "standard",
    "runtime",
    "dependencies",
    "database",
    "securityData",
    "provider",
    "arubaPlatform",
    "react",
    "e2e",
    "image",
    "migrationStorage",
    "deploy",
    "failClosed",
  ];
  const lines = [`lane=${result.lane}`];
  for (const key of booleans) {
    const outputKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    lines.push(`${outputKey}=${result[key]}`);
  }
  lines.push(`files_json=${JSON.stringify(result.files)}`);
  lines.push(`unknown_json=${JSON.stringify(result.unknown)}`);
  return lines.join("\n");
}

export function run(argv = process.argv.slice(2)) {
  const [base, head, format = "outputs"] = argv;
  if (!/^[0-9a-f]{40}$/.test(base ?? "") || !/^[0-9a-f]{40}$/.test(head ?? "")) {
    throw new Error("Uso: node scripts/change-impact.mjs <base-sha> <head-sha> [json]");
  }
  const result = classifyFiles(changedFiles(base, head));
  process.stdout.write(
    format === "json" ? `${JSON.stringify(result, null, 2)}\n` : `${outputs(result)}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) run();

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sha = /^[0-9a-f]{40}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
const schemaPattern = /^\d{3}_[A-Za-z0-9_]+\.sql$/;

export function changelogSection(changelog, version) {
  const marker = `## ${version}`;
  const start = changelog.split("\n").findIndex((line) => line.trim() === marker);
  if (start < 0) throw new Error(`Voce changelog ${version} assente`);
  const rest = changelog.split("\n").slice(start + 1);
  const end = rest.findIndex((line) => /^##\s+/.test(line));
  const section = rest
    .slice(0, end < 0 ? undefined : end)
    .join("\n")
    .trim();
  if (!section) throw new Error(`Voce changelog ${version} vuota`);
  return section;
}

export function releaseManifest({
  attestation,
  commit,
  imageDigest,
  rollbackDigest,
  schema,
  version,
}) {
  if (!versionPattern.test(version)) throw new Error("Versione release non valida");
  if (!sha.test(commit)) throw new Error("Commit release non valido");
  if (!digest.test(imageDigest) || (rollbackDigest !== null && !digest.test(rollbackDigest))) {
    throw new Error("Digest release non valido");
  }
  if (!schemaPattern.test(schema)) throw new Error("Schema release non valido");
  if (!attestation.startsWith("https://github.com/")) throw new Error("Attestazione non valida");
  return { version, commit, imageDigest, rollbackDigest, schema, attestation };
}

export async function prepareRelease(outputDirectory, values) {
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const manifest = releaseManifest(values);
  const notes = `${changelogSection(changelog, values.version)}\n\n## Integrità della distribuzione\n\n- Commit e digest sono stati verificati dal gate exact-SHA e dal readback Production.\n- Il manifest allegato registra immagine, schema, attestazione e, quando esiste un predecessore, digest di rollback immutabili.\n`;
  await writeFile(
    path.join(outputDirectory, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(path.join(outputDirectory, "release-notes.md"), notes, { mode: 0o600 });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 7) {
    throw new Error(
      "Uso: prepare-production-release <dir> <version> <commit> <image> <rollback> <schema> <attestazione>",
    );
  }
  const [outputDirectory, version, commit, imageDigest, rollbackValue, schema, attestation] = argv;
  const rollbackDigest = rollbackValue || null;
  await prepareRelease(outputDirectory, {
    attestation,
    commit,
    imageDigest,
    rollbackDigest,
    schema,
    version,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

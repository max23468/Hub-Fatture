import { spawn } from "node:child_process";
import path from "node:path";

const MAX_XML_BYTES = 4_900_000;
const schema = path.resolve("schemas/fatturapa/FatturaPA_v1.2.2.xsd");
const catalog = path.resolve("schemas/fatturapa/catalog.xml");

export async function validateFatturaXml(xml: string): Promise<void> {
  const size = Buffer.byteLength(xml);
  if (size > MAX_XML_BYTES) throw new Error("XML oltre il limite consentito");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DTD ed entità non sono ammesse");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("xmllint", ["--nonet", "--noout", "--schema", schema, "-"], {
      env: { ...process.env, XML_CATALOG_FILES: catalog },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let error = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (error.length < 16_384) error += chunk;
    });
    child.on("error", (cause) => {
      clearTimeout(timeout);
      reject(new Error("Validatore FatturaPA non disponibile", { cause }));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error("Validazione FatturaPA scaduta"));
      else if (code === 0) resolve();
      else reject(new Error(`XML non conforme a FatturaPA: ${error.trim()}`));
    });
    child.stdin.end(xml);
  });
}

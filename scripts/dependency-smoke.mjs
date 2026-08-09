// Ogni dipendenza di produzione dichiarata deve essere importabile dal runtime, non
// soltanto presente nel lockfile. La lista si legge dal manifest: aggiungere una
// dipendenza senza verificarla qui non deve essere possibile per dimenticanza.
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const names = Object.keys(manifest.dependencies ?? {});

for (const name of names) {
  // `@react-router/serve` espone soltanto la CLI: ne verifichiamo il manifest.
  // react-doctor-disable-next-line react-doctor/async-await-in-loop
  await (name === "@react-router/serve"
    ? import(`${name}/package.json`, { with: { type: "json" } })
    : import(name));
}

console.log(`Import verificati: ${names.length}`);

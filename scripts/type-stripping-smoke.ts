const runtime: { name: string; ready: boolean } = {
  name: "node-type-stripping",
  ready: true,
};

if (!runtime.ready) {
  throw new Error("Type stripping non disponibile");
}

console.log(`${runtime.name}: ok`);

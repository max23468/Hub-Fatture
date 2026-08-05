import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Hub Fatture" },
    { name: "description", content: "Scaffolding applicativo Hub Fatture" },
  ];
}

export default function Home() {
  return (
    <main>
      <h1>Hub Fatture</h1>
      <p>Scaffolding applicativo pronto. Nessun dato reale è caricato.</p>
    </main>
  );
}

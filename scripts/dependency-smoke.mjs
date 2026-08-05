const packages = [
  "@react-router/node",
  "@shopify/shopify-api",
  "nodemailer",
  "otpauth",
  "pg",
  "react",
  "react-dom",
  "react-router",
  "xmlbuilder2",
  "zod",
];

await Promise.all(packages.map((packageName) => import(packageName)));
await import("@react-router/serve/package.json", { with: { type: "json" } });
console.log(`Import verificati: ${packages.length + 1}`);

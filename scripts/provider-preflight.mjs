import process from "node:process";

export function verifyTarget(expected, observed) {
  for (const field of ["provider", "account", "target"]) {
    if (!expected[field] || expected[field] !== observed[field]) {
      throw new Error(`Preflight provider fallito: ${field} non coincide`);
    }
  }

  return {
    status: "ready",
    provider: observed.provider,
    account: observed.account,
    target: observed.target,
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [
    expectedProvider,
    expectedAccount,
    expectedTarget,
    observedProvider,
    observedAccount,
    observedTarget,
  ] = process.argv.slice(2);

  try {
    console.log(
      JSON.stringify(
        verifyTarget(
          { provider: expectedProvider, account: expectedAccount, target: expectedTarget },
          { provider: observedProvider, account: observedAccount, target: observedTarget },
        ),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Preflight provider fallito");
    process.exitCode = 1;
  }
}

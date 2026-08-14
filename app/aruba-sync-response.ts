import { publicError } from "../src/errors.ts";

export async function arubaSyncResponse(run: () => Promise<unknown>, headers?: HeadersInit) {
  try {
    return Response.json(await run(), { headers });
  } catch (error) {
    const result = publicError(error);
    const stable =
      result.code === "ARUBA_BATCH_INVALID"
        ? {
            code: "ARUBA_INVENTORY_INVALID" as const,
            message: "L’inventario Aruba contiene dati non validi.",
            status: 422,
          }
        : result;
    return Response.json({ code: stable.code, message: stable.message }, { status: stable.status });
  }
}

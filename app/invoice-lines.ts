import { decimalToCents } from "../src/orders.ts";

export function invoiceLinesFromForm(form: URLSearchParams) {
  const orderIds = form.getAll("documentOrderId");
  const descriptions = form.getAll("documentDescription");
  const quantities = form.getAll("documentQuantity");
  const amounts = form.getAll("documentUnitAmount");
  const positions = form.getAll("documentLinePosition");
  if (
    !orderIds.length ||
    [descriptions, quantities, amounts, positions].some(
      (values) => values.length !== orderIds.length,
    )
  ) {
    throw new Error("Righe documento incomplete");
  }
  const seenPositions = new Set<number>();
  return orderIds
    .map((orderId, index) => {
      const position = Number(positions[index]);
      if (!Number.isSafeInteger(position) || position < 0 || seenPositions.has(position)) {
        throw new Error("Posizione riga documento non valida");
      }
      seenPositions.add(position);
      return {
        orderId,
        description: descriptions[index],
        quantity: Number(quantities[index]),
        unitAmount: decimalToCents(amounts[index] ?? ""),
        position,
      };
    })
    .sort((left, right) => left.position - right.position)
    .map(({ position: _, ...line }) => line);
}

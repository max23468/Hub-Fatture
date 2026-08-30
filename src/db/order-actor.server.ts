export interface OrderActor {
  id?: number;
  type?: "ADMIN" | "SYSTEM";
  requestId: string;
}

export function auditOrderActor(actor: OrderActor) {
  return {
    actorType: actor.type ?? ("ADMIN" as const),
    actorId: actor.id === undefined ? null : String(actor.id),
  };
}

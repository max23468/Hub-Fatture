import { ArrowLeft } from "lucide-react";
import { data, Link, redirect, useActionData, useLoaderData } from "react-router";
import type { Route } from "./+types/customer-detail";

import { AppShell } from "../components/app-shell";
import { CustomerDetailView } from "../components/customer-detail-view";
import { customerKindLabels, copy } from "../copy.it";
import { privateRouteMeta } from "../metadata";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import { getCustomer } from "../../src/db/customers.server.ts";
import {
  acceptCustomerIdentityException,
  getCustomerIdentityExceptionProposal,
} from "../../src/db/customer-identity-exceptions.server.ts";
import { importOrders } from "../../src/db/order-import.server.ts";
import { publicError } from "../../src/errors.ts";
import { readForm } from "../../src/http.server.ts";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const [customer, identityException] = await Promise.all([
    getCustomer(params.customerId),
    getCustomerIdentityExceptionProposal(params.customerId),
  ]);
  if (!customer) throw new Response("Cliente non trovato", { status: 404 });
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    customer,
    identityException,
    outcome: new URL(request.url).searchParams.get("esito") ?? "",
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  try {
    const user = await requireSessionUser(request);
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    if (
      form.get("intent") !== "accept-customer-identity-exception" ||
      form.get("confirmException") !== "accepted"
    ) {
      throw new Response("Azione non supportata", { status: 400 });
    }
    const actor = { id: user.id, canApprove: user.canApprove, requestId: requestId(request) };
    const replay = await acceptCustomerIdentityException(params.customerId, actor);
    if (replay.length) await importOrders(replay, actor);
    return redirect(`/clienti/${params.customerId}?esito=deroga-allineata`);
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("customer", { error });
}

export default function CustomerDetail() {
  const { username, canApprove, csrfToken, customer, identityException, outcome } =
    useLoaderData<typeof loader>();
  const error = useActionData<typeof action>();
  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <header className="customer-detail-heading">
        <Link className="back-link" to="/clienti">
          <ArrowLeft aria-hidden="true" size={17} strokeWidth={1.8} />
          {copy.customers.backToCustomers}
        </Link>
        <div className="title-block customer-detail-title">
          <p className="eyebrow">{copy.customers.eyebrow}</p>
          <h1>{customer.display_name}</h1>
          <p>{customerKindLabels[customer.kind] ?? copy.common.unknownType}</p>
        </div>
      </header>
      {error ? (
        <p className="error" role="alert">
          {error.message}
        </p>
      ) : null}
      {outcome === "deroga-allineata" ? (
        <p className="success" role="status">
          {copy.customers.identityExceptionCompleted}
        </p>
      ) : null}
      <CustomerDetailView
        canApprove={canApprove}
        csrfToken={csrfToken}
        customer={customer}
        identityException={identityException}
      />
    </AppShell>
  );
}

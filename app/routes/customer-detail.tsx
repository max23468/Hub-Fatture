import { ArrowLeft } from "lucide-react";
import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/customer-detail";

import { AppShell } from "../components/app-shell";
import { CustomerDetailView } from "../components/customer-detail-view";
import { customerKindLabels, copy } from "../copy.it";
import { requireSessionUser } from "../../src/db/auth.server.ts";
import { getCustomer } from "../../src/db/customers.server.ts";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const customer = await getCustomer(params.customerId);
  if (!customer) throw new Response("Cliente non trovato", { status: 404 });
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    customer,
  };
}

export function meta(_: Route.MetaArgs) {
  return [{ title: "Cliente · Hub Fatture" }];
}

export default function CustomerDetail() {
  const { username, canApprove, csrfToken, customer } = useLoaderData<typeof loader>();
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
      <CustomerDetailView customer={customer} />
    </AppShell>
  );
}

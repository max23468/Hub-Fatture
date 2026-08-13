import { isRouteErrorResponse } from "react-router";
import type { MetaDescriptor } from "react-router";

import { copy } from "./copy.it.ts";

export const PRIVATE_ROBOTS_DIRECTIVE = "noindex, nofollow, noarchive, nosnippet, noimageindex";

const pages = {
  app: { title: copy.appName, description: copy.publicPage.intro },
  dashboard: { title: copy.dashboard.title, description: copy.dashboard.summaryLabel },
  login: { title: copy.login.title, description: copy.login.intro },
  setup: { title: copy.setup.title, description: copy.setup.intro },
  orders: { title: copy.orders.title, description: copy.orders.intro },
  order: { title: "Dettaglio ordine", description: copy.orderDetail.orderStatusHelp },
  preparation: { title: "Preparazione fattura", description: copy.publicPage.intro },
  documents: { title: copy.documents.title, description: copy.documents.intro },
  creditNote: { title: copy.creditNote.title, description: copy.creditNote.approvalHelp },
  customers: { title: copy.customers.title, description: copy.customers.intro },
  customer: { title: "Cliente", description: copy.customers.currentRecordHelp },
  activity: { title: copy.activity.title, description: copy.activity.intro },
  settings: { title: copy.settings.title, description: copy.settings.intro },
  arubaSynthetic: { title: "Simulatore Aruba", description: copy.arubaSynthetic.intro },
  notFound: { title: copy.error.notFound, description: copy.error.notFoundHelp },
  unexpectedError: { title: "Errore", description: copy.error.unexpectedHelp },
} as const;

export type PrivatePage = keyof typeof pages;

export const privatePageKeys = Object.freeze(Object.keys(pages) as PrivatePage[]);

export function privatePageMeta(
  page: PrivatePage,
  overrides: { title?: string; description?: string } = {},
): MetaDescriptor[] {
  const metadata = pages[page];
  const pageTitle = overrides.title ?? metadata.title;
  const description = overrides.description ?? metadata.description;
  const title = pageTitle === copy.appName ? copy.appName : `${pageTitle} · ${copy.appName}`;

  return [
    { title },
    { name: "description", content: description },
    { name: "application-name", content: copy.appName },
    { name: "apple-mobile-web-app-title", content: copy.appName },
    { name: "format-detection", content: "telephone=no" },
    { name: "robots", content: PRIVATE_ROBOTS_DIRECTIVE },
    { name: "googlebot", content: PRIVATE_ROBOTS_DIRECTIVE },
    { name: "referrer", content: "same-origin" },
    {
      tagName: "meta",
      name: "theme-color",
      media: "(prefers-color-scheme: light)",
      content: "#f4f8fa",
    },
    {
      tagName: "meta",
      name: "theme-color",
      media: "(prefers-color-scheme: dark)",
      content: "#071722",
    },
    { property: "og:type", content: "website" },
    { property: "og:locale", content: "it_IT" },
    { property: "og:site_name", content: copy.appName },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { name: "twitter:card", content: "summary" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
  ];
}

export function privateRouteMeta(
  page: PrivatePage,
  { error, ...overrides }: { error?: unknown; title?: string; description?: string } = {},
): MetaDescriptor[] {
  if (isRouteErrorResponse(error) && error.status === 404) return privatePageMeta("notFound");
  if (error) return privatePageMeta("unexpectedError");
  return privatePageMeta(page, overrides);
}

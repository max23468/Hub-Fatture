const retainedControlListParameters = ["gravita", "origine", "tipo", "q", "cursore"] as const;

export function controlsActionRedirect(
  requestUrl: string,
  options: {
    outcome: string;
    selectedControlId?: string;
    state?: "OPEN" | "WAITING";
  },
) {
  const current = new URL(requestUrl);
  const next = new URLSearchParams();
  for (const parameter of retainedControlListParameters) {
    const value = current.searchParams.get(parameter);
    if (value) next.set(parameter, value);
  }
  if (options.state === "WAITING") next.set("vista", "attesa");
  if (options.selectedControlId) next.set("id", options.selectedControlId);
  next.set("esito", options.outcome);
  return `/controlli?${next.toString()}`;
}

export function controlLink(control: { id: string }, search: URLSearchParams) {
  const next = new URLSearchParams(search);
  next.set("id", control.id);
  next.delete("esito");
  return `/controlli?${next.toString()}`;
}

export function controlsListLink(search: URLSearchParams) {
  const query = search.toString();
  return query ? `/controlli?${query}` : "/controlli";
}

export function controlsPageLink(search: URLSearchParams, cursor: string) {
  const next = new URLSearchParams(search);
  next.delete("id");
  next.delete("esito");
  if (cursor) next.set("cursore", cursor);
  else next.delete("cursore");
  return controlsListLink(next);
}

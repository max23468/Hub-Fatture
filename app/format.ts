const euroFormatter = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });
const dateFormatter = new Intl.DateTimeFormat("it-IT", {
  dateStyle: "medium",
  timeZone: "Europe/Rome",
});
const dateTimeFormatter = new Intl.DateTimeFormat("it-IT", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Rome",
});
const compactDateFormatter = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Rome",
});
const compactDateTimeFormatter = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Rome",
});
const romeIsoDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const regionFormatter = new Intl.DisplayNames("it", { type: "region" });

type Address = Record<string, string | undefined>;

export function euros(cents: number | string): string {
  return euroFormatter.format(Number(cents) / 100);
}

export function date(value: string): string {
  return dateFormatter.format(new Date(`${value}T12:00:00Z`));
}

export function dateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

export function compactDate(value: string): string {
  return compactDateFormatter.format(new Date(`${value}T12:00:00Z`));
}

export function compactDateTime(value: string): string {
  return compactDateTimeFormatter.format(new Date(value));
}

export function isoDateTime(value: string | Date): string {
  return new Date(value).toISOString();
}

export function dateAfterInRome(days: number, reference = new Date()): string {
  const current = Object.fromEntries(
    romeIsoDateFormatter.formatToParts(reference).map((part) => [part.type, part.value]),
  );
  const target = new Date(
    Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day) + days),
  );
  const result = Object.fromEntries(
    romeIsoDateFormatter.formatToParts(target).map((part) => [part.type, part.value]),
  );
  return `${result.year}-${result.month}-${result.day}`;
}

export function address(value: Address): string {
  const country = value.countryCode
    ? (regionFormatter.of(value.countryCode.toUpperCase()) ?? value.countryCode)
    : undefined;
  return [
    value.line1,
    value.line2,
    [value.postalCode, value.city].filter(Boolean).join(" "),
    value.province,
    country,
  ]
    .filter(Boolean)
    .join(", ");
}

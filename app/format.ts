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

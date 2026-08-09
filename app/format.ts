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

export function euros(cents: number | string): string {
  return euroFormatter.format(Number(cents) / 100);
}

export function date(value: string): string {
  return dateFormatter.format(new Date(`${value}T12:00:00Z`));
}

export function dateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

export function fiscalNumberLabel(series: string, year: number, number: number): string {
  return `${series} ${String(number).padStart(4, "0")}/${String(year).slice(-2)}`;
}

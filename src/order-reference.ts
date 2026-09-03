export function salesChannelLabel(provider: string) {
  return provider === "SHOPIFY" ? "Shopify" : provider === "EBAY" ? "eBay" : "Canale";
}

export function orderReferenceLabel(provider: string, displayNumber: string) {
  return `${displayNumber} ${salesChannelLabel(provider)}`;
}

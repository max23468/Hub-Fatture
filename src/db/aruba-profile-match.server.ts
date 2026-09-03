import { acceptedDocumentFiscalIdentity, type FiscalProfile } from "../documents.ts";

export function acceptedProfileMatches(
  profile: FiscalProfile,
  identity: ReturnType<typeof acceptedDocumentFiscalIdentity>,
) {
  return (
    profile.series === "FPR" &&
    profile.transmitter.countryCode === identity.transmitter.countryCode &&
    profile.transmitter.taxCode === identity.transmitter.taxCode &&
    profile.seller.vatCountryCode === identity.seller.vatCountryCode &&
    profile.seller.vatCode === identity.seller.vatCode &&
    (profile.seller.taxCode ?? null) === (identity.seller.taxCode ?? null) &&
    profile.seller.taxRegime === identity.seller.taxRegime &&
    profile.taxNature === identity.taxNature &&
    profile.legalReference === identity.legalReference &&
    profile.payment.condition === identity.payment.condition
  );
}

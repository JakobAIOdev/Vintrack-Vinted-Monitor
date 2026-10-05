export const CHECKOUT_RISK_WARNING_VERSION = 1;
export const CHECKOUT_CONSENT_REQUIRED = "CHECKOUT_CONSENT_REQUIRED";

export function checkoutRiskAccepted(version: unknown, acceptedAt: unknown) {
    return version === CHECKOUT_RISK_WARNING_VERSION && acceptedAt != null;
}

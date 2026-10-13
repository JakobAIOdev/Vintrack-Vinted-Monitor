import test from "node:test";
import assert from "node:assert/strict";
import {
    CHECKOUT_CURRENCIES,
    checkoutCurrencyDigits,
    checkoutDefaultCurrency,
    checkoutMaximumMinor,
    isAutoCheckoutPreference,
    isCheckoutCurrency,
    parseCheckoutAmount,
} from "../../src/lib/checkout.ts";
import { REGIONS } from "../../src/lib/regions.ts";

test("every current currency has a usable explicit limit with correct minor units", () => {
    for (const currency of CHECKOUT_CURRENCIES) {
        const digits = checkoutCurrencyDigits(currency);
        const amount = digits === 0 ? "18" : `18.${"1".repeat(digits)}`;
        const minor = parseCheckoutAmount(amount, currency);
        assert.equal(
            minor,
            18 * 10 ** digits + Number("1".repeat(digits)),
            currency,
        );
        assert.equal(
            isAutoCheckoutPreference(
                { warningVersion: 2, currency, maxTotalMinor: minor },
                "card",
            ),
            true,
            currency,
        );
        assert.equal(
            isAutoCheckoutPreference(
                {
                    warningVersion: 2,
                    currency,
                    maxTotalMinor: checkoutMaximumMinor(currency) + 1,
                },
                "card",
            ),
            false,
            currency,
        );
    }
    for (const currency of [
        "ZZZ",
        "XXX",
        "BTC",
        "eur",
        "toString",
        "__proto__",
        null,
        {},
    ])
        assert.equal(isCheckoutCurrency(currency), false);
});

test("zero, two, three and four decimal currencies never round an extra payable fraction", () => {
    for (const [currency, amount, minor] of [
        ["JPY", "18", 18],
        ["JPY", "18.0000", 18],
        ["JPY", "18.01", null],
        ["PLN", "18,29", 1829],
        ["PLN", "18.291", null],
        ["PLN", "18.2900", 1829],
        ["KWD", "18.291", 18291],
        ["KWD", "18.2911", null],
        ["CLF", "18.2914", 182914],
    ] as const)
        assert.equal(parseCheckoutAmount(amount, currency), minor);
    for (const amount of [
        "-1",
        "1e2",
        "NaN",
        "Infinity",
        " 18",
        "1.00000",
        "18,29.1",
        "",
    ]) {
        assert.equal(parseCheckoutAmount(amount, "PLN"), null);
    }
});

test("new drafts default to the linked regional currency and never replace an existing opt-in", () => {
    for (const region of REGIONS)
        assert.equal(
            checkoutDefaultCurrency(region.domain),
            region.currencyCode,
        );
    assert.equal(checkoutDefaultCurrency("www.vinted.com"), "USD");
    assert.equal(checkoutDefaultCurrency("www.vinted.pl.evil.test"), "EUR");
    assert.equal(
        isAutoCheckoutPreference(
            { warningVersion: 2, currency: "EUR", maxTotalMinor: 1829 },
            "card",
        ),
        true,
    );
    assert.equal(
        isAutoCheckoutPreference(
            { warningVersion: 2, currency: "KWD", maxTotalMinor: 1 },
            "card",
        ),
        true,
    );
});

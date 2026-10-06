import test from "node:test";
import assert from "node:assert/strict";
import {
    checkoutReturnPath,
    parseCheckoutIds,
    checkoutDomain,
    isCheckoutUrl,
    checkoutPaymentOptions,
    checkoutPaymentAllowed,
    isCheckoutPreferences,
} from "../../src/lib/checkout.ts";

test("payment preferences follow the linked region and web support", () => {
    for (const domain of ["vinted.de", "www.vinted.at", "www.vinted.be"]) {
        assert.equal(checkoutPaymentAllowed(domain, "paypal"), true);
    }
    for (const domain of [
        "www.vinted.fr",
        "www.vinted.co.uk",
        "www.vinted.pl",
        "www.vinted.nl",
    ]) {
        assert.equal(checkoutPaymentAllowed(domain, "paypal"), false);
        assert.equal(checkoutPaymentAllowed(domain, "google_pay"), true);
    }
    assert.equal(checkoutPaymentAllowed("vinted.de", "klarna"), true);
    assert.equal(checkoutPaymentAllowed("vinted.fr", "klarna"), false);
    assert.equal(checkoutPaymentAllowed("vinted.be", "bancontact"), true);
    assert.equal(checkoutPaymentAllowed("vinted.nl", "ideal"), true);
    assert.equal(checkoutPaymentAllowed("vinted.pl", "blik"), true);
    assert.equal(checkoutPaymentAllowed("vinted.pl", "przelewy24"), true);
    assert.deepEqual(checkoutPaymentOptions("vinted.de.evil.test"), []);
    assert.equal(
        isCheckoutPreferences({ shipping: "home", payment: "google_pay" }),
        true,
    );
    assert.equal(
        isCheckoutPreferences({ shipping: "home", payment: "apple_pay" }),
        false,
    );
    assert.equal(
        isCheckoutPreferences({ shipping: "home", payment: "constructor" }),
        false,
    );
});

test("checkout IDs reject ambiguous, non-positive and unsafe numbers", () => {
    assert.deepEqual(parseCheckoutIds("17", "1234567890"), {
        monitorId: 17,
        itemId: 1234567890,
    });
    for (const id of [
        "0",
        "-1",
        "1x",
        "1.1",
        "01",
        "1e3",
        "9007199254740993",
    ]) {
        assert.equal(parseCheckoutIds("17", id), null);
        assert.equal(parseCheckoutIds(id, "123"), null);
    }
    assert.equal(parseCheckoutIds("2147483648", "123"), null);
});

test("checkout redirects stay on the linked Vinted checkout", () => {
    assert.equal(checkoutDomain("vinted.de"), "www.vinted.de");
    for (const domain of [
        "vinted.de.evil.test",
        "evil.test",
        "vinted.de:443",
        "user@vinted.de",
    ])
        assert.equal(checkoutDomain(domain), null);
    assert.equal(
        isCheckoutUrl(
            "https://www.vinted.de/checkout?purchase_id=synthetic",
            "www.vinted.de",
        ),
        true,
    );
    for (const raw of [
        "javascript:alert(1)",
        "https://evil.test/checkout",
        "https://www.vinted.fr/checkout",
        "https://user@www.vinted.de/checkout",
        "https://www.vinted.de/checkout/payment",
        "https://www.vinted.de/checkout#secret",
        "http://www.vinted.de/checkout",
    ])
        assert.equal(isCheckoutUrl(raw, "www.vinted.de"), false);
});

test("login only returns to a validated checkout handoff path", () => {
    assert.equal(checkoutReturnPath("/checkout/17/123"), "/checkout/17/123");
    for (const raw of [
        "https://evil.test",
        "//evil.test",
        "/checkout/17/123?next=https://evil.test",
        "/checkout/0/123",
        "/checkout/17/123/../admin",
        undefined,
    ])
        assert.equal(checkoutReturnPath(raw), "/dashboard");
});

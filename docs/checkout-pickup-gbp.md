# Saved pickup points and checkout currencies

## Use a saved pickup point

1. Set your preferred pickup point in Vinted.
2. Open **Account → Oneclick checkout → Delivery** in Vintrack.
3. Choose **Pickup at my saved Vinted point** and save your preferences.
4. Check the point and delivery details in the prepared Vinted checkout.

Vintrack uses the saved point offered by the current checkout. It does not
search for or substitute a nearby point. If the point is missing or changed,
the delivery options do not match, or contact details are incomplete, complete
the checkout manually in Vinted.

Normal Oneclick stops before payment. Automatic payment requires a separate
opt-in and confirmed delivery details.

## Set a spending limit and currency

Automatic-payment limits include shipping and fees. Choose the currency beside
the amount field. The currency picker shows common Vinted-region currencies;
search by currency code to find another supported currency.

Changing currency clears the draft amount and requires accepting the payment
warning again before saving. Limits are never converted: an EUR limit cannot
authorize a GBP purchase. Changing delivery also requires acceptance again when
automatic payment is enabled.

The final Vinted total must use exactly the saved limit currency and remain
within the limit. Wallet deductions, currency conversion or missing totals stop
automatic payment. Supporting a currency does not add a Vinted region or payment
provider. PayPal remains restricted to DE/AT/BE; UK GBP can use a saved card.

## Enter exact amounts

Currencies use their own decimal places: JPY uses zero, PLN two, KWD three and
CLF four. Nonzero extra decimal places are rejected instead of being rounded.
The maximum configurable limit is 10,000 major units of the chosen currency.
Unknown currencies and cryptocurrency tickers cannot authorize payment.

Use the current [browser extension](browser-extension.md) for all currency and
pickup options. After updating an unpacked extension, reload existing Vintrack
and Vinted pages. If an attempt has an unclear result, check Vinted before
continuing; changing currency or delivery does not restart that payment.

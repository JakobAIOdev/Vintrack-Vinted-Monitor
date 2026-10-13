"use client";

import { useRef, useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronDown, Search } from "lucide-react";
import {
    CHECKOUT_CURRENCIES,
    isCheckoutCurrency,
    type CheckoutCurrency,
} from "@/lib/checkout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const COMMON_CURRENCIES: CheckoutCurrency[] = [
    "EUR",
    "GBP",
    "PLN",
    "CZK",
    "SEK",
    "DKK",
    "RON",
    "HUF",
    "USD",
];

export function CheckoutCurrencyPicker({
    value,
    disabled,
    onChange,
}: {
    value: CheckoutCurrency;
    disabled: boolean;
    onChange: (currency: CheckoutCurrency) => void;
}) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const input = useRef<HTMLInputElement>(null);
    const buttons = useRef<(HTMLButtonElement | null)[]>([]);
    const query = search.trim().toUpperCase();
    const matches = query
        ? CHECKOUT_CURRENCIES.filter((currency) => currency.startsWith(query))
        : [
              value,
              ...COMMON_CURRENCIES.filter((currency) => currency !== value),
          ];
    const visible = matches.slice(0, 9);

    function select(currency: CheckoutCurrency) {
        if (currency !== value) onChange(currency);
        setOpen(false);
    }

    return (
        <Popover.Root
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (next) setSearch("");
            }}
        >
            <Popover.Trigger asChild>
                <Button
                    id="checkout-limit-currency"
                    variant="outline"
                    className="h-10 w-full justify-between gap-2 px-3 font-normal"
                    disabled={disabled}
                    aria-label={`Spending limit currency: ${value}`}
                >
                    {value}
                    <ChevronDown
                        className="text-muted-foreground size-3.5"
                        aria-hidden="true"
                    />
                </Button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align="end"
                    sideOffset={6}
                    collisionPadding={16}
                    className="bg-popover text-popover-foreground z-50 w-56 max-w-[calc(100vw-2rem)] rounded-lg border p-2 shadow-lg"
                    aria-label="Choose spending limit currency"
                    onOpenAutoFocus={(event) => {
                        event.preventDefault();
                        input.current?.focus();
                    }}
                >
                    <div className="relative mb-2">
                        <Search
                            className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4"
                            aria-hidden="true"
                        />
                        <Input
                            ref={input}
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder="Search all currencies"
                            aria-label="Search currency code"
                            maxLength={3}
                            className="h-9 pl-8 uppercase placeholder:normal-case"
                            onKeyDown={(event) => {
                                if (
                                    event.key === "ArrowDown" &&
                                    visible.length
                                ) {
                                    event.preventDefault();
                                    buttons.current[0]?.focus();
                                }
                                if (
                                    event.key === "Enter" &&
                                    isCheckoutCurrency(query)
                                ) {
                                    event.preventDefault();
                                    select(query);
                                }
                            }}
                        />
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                        {visible.map((currency, index) => (
                            <button
                                key={currency}
                                ref={(button) => {
                                    buttons.current[index] = button;
                                }}
                                type="button"
                                className="hover:bg-accent focus-visible:bg-accent flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm outline-none"
                                aria-label={`Use ${currency}`}
                                onClick={() => select(currency)}
                                onKeyDown={(event) => {
                                    if (event.key === "ArrowDown") {
                                        event.preventDefault();
                                        buttons.current[
                                            Math.min(
                                                index + 1,
                                                visible.length - 1,
                                            )
                                        ]?.focus();
                                    } else if (event.key === "ArrowUp") {
                                        event.preventDefault();
                                        if (index === 0) input.current?.focus();
                                        else
                                            buttons.current[index - 1]?.focus();
                                    }
                                }}
                            >
                                {currency}
                                {currency === value && (
                                    <Check
                                        className="size-3.5"
                                        aria-hidden="true"
                                    />
                                )}
                            </button>
                        ))}
                        {!visible.length && (
                            <p
                                role="status"
                                className="text-muted-foreground px-2.5 py-3 text-sm"
                            >
                                No matching currency.
                            </p>
                        )}
                    </div>
                    {matches.length > visible.length && (
                        <p className="text-muted-foreground px-2.5 pt-2 text-xs">
                            Type more to narrow the results.
                        </p>
                    )}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}

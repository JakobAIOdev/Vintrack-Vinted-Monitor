"use client";

type Prompt = {
    autoCheckout: boolean;
    resolve: () => void;
    reject: (error: Error) => void;
};
let prompt: Prompt | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
export const subscribeCheckoutConsent = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
export const getCheckoutConsentPrompt = () => prompt;
export const getServerCheckoutConsentPrompt = () => null;

export function requestCheckoutConsent(autoCheckout = false): Promise<void> {
    if (pending) return pending;
    pending = new Promise<void>((resolve, reject) => {
        prompt = { autoCheckout, resolve, reject };
    });
    listeners.forEach((listener) => listener());
    return pending;
}

export function finishCheckoutConsent(accepted: boolean) {
    const current = prompt;
    prompt = null;
    pending = null;
    listeners.forEach((listener) => listener());
    if (accepted) current?.resolve();
    else
        current?.reject(
            new Error(
                "Checkout cancelled. Accept the risk warning before using checkout.",
            ),
        );
}

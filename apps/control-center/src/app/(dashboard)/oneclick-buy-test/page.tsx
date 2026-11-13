import { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
    title: "Full checkout setup | Vintrack",
    description: "Configure Full checkout and its payment limit.",
};

export default function OneClickBuyTestPage() {
    redirect("/account?connection=vinted#checkout-settings");
}

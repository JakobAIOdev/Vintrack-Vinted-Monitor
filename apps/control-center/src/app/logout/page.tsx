import { auth, signOut } from "@/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRightFromLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
    title: "Logout | Vintrack",
    description: "Sign out from your Vintrack dashboard session.",
    robots: {
        index: false,
        follow: false,
    },
};

async function signOutFromDashboard() {
    "use server";

    await signOut({ redirectTo: "/" });
}

export default async function LogoutPage() {
    const session = await auth();

    if (!session?.user) {
        redirect("/login");
    }

    return (
        <div className="bg-background text-foreground relative min-h-screen overflow-hidden">
            <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6 sm:px-8">
                <Link href="/dashboard" className="flex items-center gap-3">
                    <div className="bg-foreground text-background flex h-8 w-8 items-center justify-center rounded-lg">
                        <span className="text-sm leading-none font-semibold">
                            V
                        </span>
                    </div>
                    <p className="text-foreground text-[15px] font-semibold">
                        Vintrack
                    </p>
                </Link>

                <ThemeToggle compact />
            </header>

            <main className="mx-auto flex min-h-[calc(100vh-88px)] w-full max-w-6xl items-center justify-center px-6 pb-10 sm:px-8">
                <div className="border-border/70 bg-card relative w-full max-w-xl overflow-hidden rounded-2xl border p-6 sm:p-8">
                    <div className="mb-6 space-y-4">
                        <div className="flex items-start gap-4">
                            <div className="space-y-2">
                                <h1 className="text-3xl font-semibold tracking-tight">
                                    Sign out of Vintrack?
                                </h1>
                                <p className="text-muted-foreground text-sm leading-7 sm:text-base">
                                    You are signed in as{" "}
                                    <span className="text-foreground font-medium">
                                        {session.user.name ||
                                            session.user.email ||
                                            "Vintrack user"}
                                    </span>
                                    . You need to sign in again to open the
                                    dashboard.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="border-border/70 bg-background/70 rounded-xl border p-4">
                        <p className="text-muted-foreground mb-4 text-sm leading-6">
                            After signing out you land on the main page
                        </p>

                        <div className="flex flex-col gap-3 sm:flex-row">
                            <form
                                action={signOutFromDashboard}
                                className="flex-1"
                            >
                                <Button
                                    type="submit"
                                    size="lg"
                                    className="h-11 w-full justify-between rounded-lg px-4 text-sm font-medium"
                                >
                                    Sign out
                                    <ArrowRightFromLine className="h-4 w-4" />
                                </Button>
                            </form>

                            <Button
                                asChild
                                variant="outline"
                                size="lg"
                                className="h-11 rounded-lg px-4 text-sm font-medium"
                            >
                                <Link href="/dashboard">
                                    <ArrowLeft className="h-4 w-4" />
                                    Back to dashboard
                                </Link>
                            </Button>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}

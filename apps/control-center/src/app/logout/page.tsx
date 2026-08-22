import { auth, signOut } from "@/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
    ArrowLeft,
    ArrowRightFromLine,
    ShieldCheck,
    Sparkles,
} from "lucide-react";
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
            <div className="absolute inset-0 -z-10">
                <div
                    className="absolute inset-0"
                    style={{
                        background:
                            "radial-gradient(circle at top left, rgba(14,165,233,0.12), transparent 30%), radial-gradient(circle at 88% 16%, rgba(248,113,113,0.14), transparent 22%), linear-gradient(180deg, color-mix(in oklab, var(--background) 88%, white 12%), var(--background))",
                    }}
                />
                <div className="absolute top-20 -left-40 h-72 w-72 rounded-full bg-sky-500/10 blur-3xl" />
                <div className="absolute -right-12 -bottom-24 h-64 w-64 rounded-full bg-rose-500/10 blur-3xl" />
            </div>

            <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6 sm:px-8">
                <Link href="/dashboard" className="flex items-center gap-3">
                    <div className="bg-foreground text-background flex h-10 w-10 items-center justify-center rounded-lg shadow-lg shadow-slate-950/10">
                        <span className="text-sm leading-none font-black">
                            V
                        </span>
                    </div>
                    <div>
                        <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.32em] uppercase">
                            Vintrack
                        </p>
                        <p className="text-foreground text-sm font-medium">
                            Session control
                        </p>
                    </div>
                </Link>

                <ThemeToggle compact />
            </header>

            <main className="mx-auto flex min-h-[calc(100vh-88px)] w-full max-w-6xl items-center justify-center px-6 pb-10 sm:px-8">
                <div className="border-border/70 bg-card/88 relative w-full max-w-xl overflow-hidden rounded-[2rem] border p-6 shadow-2xl shadow-slate-950/10 backdrop-blur-xl sm:p-8">
                    <div className="mb-8 space-y-4">
                        <div className="inline-flex items-center gap-2 rounded-full border border-sky-500/20 bg-sky-500/10 px-4 py-2 text-[11px] font-semibold tracking-[0.28em] text-sky-700 uppercase dark:text-sky-300">
                            <Sparkles className="h-3.5 w-3.5" />
                            Signed In
                        </div>

                        <div className="flex items-start gap-4">
                            <div className="space-y-2">
                                <h1 className="text-3xl font-bold tracking-tight">
                                    Leave the dashboard?
                                </h1>
                                <p className="text-muted-foreground text-sm leading-7 sm:text-base">
                                    You are signed in as{" "}
                                    <span className="text-foreground font-semibold">
                                        {session.user.name ||
                                            session.user.email ||
                                            "Vintrack user"}
                                    </span>
                                    . Logging out will close access to all
                                    protected dashboard routes until you
                                    authenticate again with your provider.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="border-border/70 bg-background/70 rounded-[1.5rem] border p-5">
                        <div className="text-muted-foreground mb-5 flex items-start gap-3 rounded-2xl border border-emerald-500/15 bg-emerald-500/8 p-4 text-sm">
                            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                            <p className="leading-6">
                                After logout you land on the main page.
                            </p>
                        </div>

                        <div className="flex flex-col gap-3 sm:flex-row">
                            <form
                                action={signOutFromDashboard}
                                className="flex-1"
                            >
                                <Button
                                    type="submit"
                                    size="lg"
                                    className="h-12 w-full justify-between rounded-2xl px-5 text-sm font-semibold shadow-lg shadow-slate-950/10"
                                >
                                    Sign out now
                                    <ArrowRightFromLine className="h-4 w-4" />
                                </Button>
                            </form>

                            <Button
                                asChild
                                variant="outline"
                                size="lg"
                                className="h-12 rounded-2xl px-5 text-sm font-semibold"
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

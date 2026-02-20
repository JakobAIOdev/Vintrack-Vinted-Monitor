import { auth } from "@/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowRight, Zap, Shield, Radio } from "lucide-react";

export default async function Home() {
  const session = await auth();

  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <nav className="flex items-center justify-between px-8 py-4 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-slate-900 flex items-center justify-center">
            <span className="text-white text-xs font-bold">V</span>
          </div>
          <span className="font-semibold text-[15px] tracking-tight">
            Vintrack
          </span>
        </div>
        <Link href="/api/auth/signin">
          <Button variant="outline" size="sm">
            Sign In
          </Button>
        </Link>
      </nav>

      <div className="flex-1 flex flex-col items-center justify-center px-6 py-24">
        <div className="text-center max-w-2xl mx-auto space-y-6">
          <div className="inline-flex items-center gap-2 bg-slate-100 text-slate-600 text-xs font-medium px-3 py-1.5 rounded-full">
            <Zap className="w-3 h-3" /> High-Performance Monitoring
          </div>

          <h1 className="text-5xl md:text-6xl font-bold tracking-tight text-slate-900">
            Find deals
            <br />
            <span className="text-slate-400">before anyone else</span>
          </h1>

          <p className="text-lg text-slate-500 max-w-md mx-auto leading-relaxed">
            The fastest Vinted monitor for resellers. Real-time alerts,
            multi-region scraping, and instant Discord notifications.
          </p>

          <div className="flex gap-3 justify-center pt-2">
            <Link href="/api/auth/signin">
              <Button size="lg" className="gap-2">
                Get Started <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl mx-auto mt-20">
          <div className="text-center space-y-2">
            <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center mx-auto">
              <Zap className="w-5 h-5 text-slate-600" />
            </div>
            <h3 className="font-semibold text-sm text-slate-900">
              Sub-Second Speed
            </h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              Optimized Go worker with proxy rotation and Cloudflare bypass.
            </p>
          </div>
          <div className="text-center space-y-2">
            <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center mx-auto">
              <Radio className="w-5 h-5 text-slate-600" />
            </div>
            <h3 className="font-semibold text-sm text-slate-900">
              Real-Time Feed
            </h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              Instant SSE updates. See items the moment they&apos;re listed.
            </p>
          </div>
          <div className="text-center space-y-2">
            <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center mx-auto">
              <Shield className="w-5 h-5 text-slate-600" />
            </div>
            <h3 className="font-semibold text-sm text-slate-900">
              Discord Alerts
            </h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              Webhook notifications with seller ratings and region data.
            </p>
          </div>
        </div>
      </div>

      <footer className="border-t border-slate-100 py-6 px-8 text-center text-xs text-slate-400">
        Vintrack &mdash; Built for speed.
      </footer>
    </div>
  );
}

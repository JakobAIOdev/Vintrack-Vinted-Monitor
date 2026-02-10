import { auth } from "@/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default async function Home() {
  const session = await auth();

  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-24 bg-gradient-to-br from-slate-900 to-slate-800 text-white">
      <div className="text-center space-y-6">
        <h1 className="text-6xl font-extrabold tracking-tight">
          Vinted<span className="text-blue-500">Track</span>
        </h1>
        <p className="text-xl text-slate-300 max-w-lg mx-auto">
          Der schnellste Vinted Monitor für Reseller. Finde Steals bevor es andere tun.
        </p>
        
        <div className="flex gap-4 justify-center mt-8">
            <Link href="/api/auth/signin">
                <Button size="lg" className="bg-blue-600 hover:bg-blue-500 text-lg px-8">
                    Jetzt Starten
                </Button>
            </Link>
            
            <Link href="https://github.com/JakobAIOdev/Vintrack" target="_blank">
                <Button variant="outline" size="lg" className="text-black bg-white hover:bg-slate-200 text-lg">
                    GitHub
                </Button>
            </Link>
        </div>
      </div>
    </div>
  );
}

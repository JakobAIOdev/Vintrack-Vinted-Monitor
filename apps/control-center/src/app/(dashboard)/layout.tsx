import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { auth } from "@/auth";
import { db } from "@/lib/db";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  let role = "free";
  if (session?.user?.id) {
    const dbUser = await db.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });
    role = dbUser?.role ?? "free";
  }

  const user = session?.user ? { ...session.user, role } : undefined;

  return (
    <div className="flex min-h-screen bg-slate-50/50">
      <Sidebar user={user} />
      
      <div className="flex-1 ml-60 flex flex-col min-w-0">
        <Header />
        <main className="flex-1 p-6 overflow-y-auto">
            <div className="max-w-350 mx-auto">
              {children}
            </div>
        </main>
      </div>
    </div>
  );
}

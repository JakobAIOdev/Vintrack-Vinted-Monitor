"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, PlusCircle, Radio, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Monitors", icon: LayoutDashboard },
  { href: "/feed", label: "Live Feed", icon: Radio },
];

interface SidebarProps {
  user?: { name?: string | null; image?: string | null; email?: string | null };
}

export function Sidebar({ user }: SidebarProps) {
  const pathname = usePathname();

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?";

  return (
    <aside className="w-60 bg-white border-r border-slate-200/60 h-full flex flex-col fixed left-0 top-0 bottom-0 z-50">

      <div className="h-14 flex items-center px-5 border-b border-slate-100">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-slate-900 flex items-center justify-center">
            <span className="text-white text-xs font-bold">V</span>
          </div>
          <span className="font-semibold text-[15px] tracking-tight text-slate-900">
            Vintrack
          </span>
        </Link>
      </div>

      <nav className="flex-1 px-3 pt-4 space-y-0.5">
        <p className="px-3 mb-2 text-[11px] font-medium text-slate-400 uppercase tracking-widest">
          Navigation
        </p>

        {navItems.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors",
                isActive
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"
              )}
            >
              <item.icon
                className={cn(
                  "w-4 h-4",
                  isActive ? "text-white" : "text-slate-400"
                )}
              />
              {item.label}
            </Link>
          );
        })}

        <div className="pt-4">
          <Link
            href="/monitors/new"
            className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-slate-500 border border-dashed border-slate-200 hover:border-slate-300 hover:text-slate-800 hover:bg-slate-50 transition-colors"
          >
            <PlusCircle className="w-4 h-4 text-slate-400" />
            New Monitor
          </Link>
        </div>
      </nav>

      <div className="p-3 border-t border-slate-100">
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          {user?.image ? (
            <img
              src={user.image}
              alt=""
              className="w-7 h-7 rounded-full"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 text-[10px] font-bold">
              {initials}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-slate-800 truncate">
              {user?.name || "User"}
            </p>
          </div>
          <Link
            href="/api/auth/signout"
            className="text-slate-400 hover:text-slate-600 transition-colors p-1"
            title="Sign out"
          >
            <LogOut className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </aside>
  );
}

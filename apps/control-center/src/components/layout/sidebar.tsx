"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, PlusCircle, Activity, Zap, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const menuItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/feed", label: "Live Feed", icon: Zap },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-white border-r h-full flex flex-col fixed left-0 top-0 bottom-0 z-50">
      <div className="h-16 flex items-center px-6 border-b border-slate-100">
        <Activity className="w-5 h-5 text-blue-600 mr-2.5" />
        <span className="font-bold text-lg tracking-tight text-slate-900">Vintrack</span>
      </div>
      <nav className="flex-1 p-4 space-y-1">
        <div className="mb-4 px-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Overview
        </div>
        
        {menuItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-slate-100 text-slate-900"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
              )}
            >
              <item.icon className={cn("w-4 h-4 mr-3", isActive ? "text-slate-900" : "text-slate-400")} />
              {item.label}
            </Link>
          );
        })}

        <div className="mt-8 px-1">
            <Link href="/monitors/new">
                <Button variant="outline" className="w-full justify-start gap-2 border-dashed border-slate-300 text-slate-600 hover:text-blue-600 hover:border-blue-300">
                    <PlusCircle className="w-4 h-4" /> New Monitor
                </Button>
            </Link>
        </div>
      </nav>

      <div className="p-4 border-t border-slate-100">
        <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer group">
            <div className="w-8 h-8 rounded-full bg-slate-900 flex items-center justify-center text-white font-bold text-xs shadow-sm group-hover:bg-blue-600 transition-colors">
                JD
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate">Jakob Dev</p>
                <p className="text-xs text-slate-500 truncate">Pro Plan</p>
            </div>
        </div>
      </div>
    </aside>
  );
}

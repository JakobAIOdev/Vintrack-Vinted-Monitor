"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, PlusCircle, Settings, Box, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

const menuItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/monitors/new", label: "Neuer Monitor", icon: PlusCircle },
  { href: "/items", label: "Alle Items", icon: Box },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-white border-r h-full flex flex-col shadow-sm hidden md:flex">
      <div className="h-16 flex items-center px-6 border-b">
        <Activity className="w-6 h-6 text-blue-600 mr-2" />
        <span className="font-bold text-xl tracking-tight">Vintrack</span>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {menuItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center px-3 py-2.5 rounded-md text-sm font-medium transition-colors",
                isActive
                  ? "bg-blue-50 text-blue-700"
                  : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              )}
            >
              <item.icon className={cn("w-5 h-5 mr-3", isActive ? "text-blue-600" : "text-slate-400")} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t bg-slate-50">
        <div className="flex items-center">
            <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-xs">
                JD
            </div>
            <div className="ml-3">
                <p className="text-sm font-medium text-slate-700">Jakob Dev</p>
                <p className="text-xs text-slate-500">Pro Plan</p>
            </div>
        </div>
      </div>
    </aside>
  );
}

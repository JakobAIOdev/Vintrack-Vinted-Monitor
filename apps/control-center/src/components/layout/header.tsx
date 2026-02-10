"use client";

import { usePathname } from "next/navigation";

export function Header() {
  const pathname = usePathname();

  const getTitle = () => {
      if (pathname === "/dashboard") return "Dashboard";
      if (pathname === "/feed") return "Live Feed";
      if (pathname === "/monitors/new") return "Create Monitor";
      if (pathname.includes("/monitors/")) return "Monitor Details";
      return "Vintrack";
  };

  return (
    <header className="h-16 bg-white border-b border-slate-100 px-8 flex items-center justify-between sticky top-0 z-40 w-full">
      <div className="flex items-center gap-2">
         <span className="text-sm font-medium text-slate-500">App</span>
         <span className="text-slate-300">/</span>
         <span className="text-sm font-semibold text-slate-900">{getTitle()}</span>
      </div>
    </header>
  );
}

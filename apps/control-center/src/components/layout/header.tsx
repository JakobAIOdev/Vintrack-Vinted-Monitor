"use client";

import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

export function Header() {
  const pathname = usePathname();

  const getBreadcrumbs = (): { label: string; isCurrent: boolean }[] => {
    if (pathname === "/dashboard")
      return [{ label: "Monitors", isCurrent: true }];
    if (pathname === "/feed")
      return [{ label: "Live Feed", isCurrent: true }];
    if (pathname === "/monitors/new")
      return [
        { label: "Monitors", isCurrent: false },
        { label: "Create", isCurrent: true },
      ];
    if (pathname.includes("/monitors/"))
      return [
        { label: "Monitors", isCurrent: false },
        { label: "Details", isCurrent: true },
      ];
    return [{ label: "Vintrack", isCurrent: true }];
  };

  const breadcrumbs = getBreadcrumbs();

  return (
    <header className="h-12 bg-white/80 backdrop-blur-sm border-b border-slate-100 px-6 flex items-center justify-between sticky top-0 z-40">
      <nav className="flex items-center gap-1 text-sm">
        {breadcrumbs.map((crumb, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-300" />}
            <span
              className={
                crumb.isCurrent
                  ? "font-medium text-slate-900"
                  : "text-slate-400"
              }
            >
              {crumb.label}
            </span>
          </span>
        ))}
      </nav>

      <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
        </span>
        Connected
      </div>
    </header>
  );
}

import { notFound, redirect } from "next/navigation";
import {
    adminSectionFromRoute,
    legacyAdminRedirect,
} from "@/lib/admin-sections";
import { renderAdminSection } from "../page";

export const dynamic = "force-dynamic";

export default async function AdminSectionPage({
    params,
    searchParams,
}: {
    params: Promise<{ section: string }>;
    searchParams: Promise<{ view?: string | string[] }>;
}) {
    const slug = (await params).section;
    const legacyRedirect = legacyAdminRedirect(slug);
    if (legacyRedirect) redirect(legacyRedirect);

    const rawView = (await searchParams).view;
    const view = typeof rawView === "string" ? rawView : null;
    const section = adminSectionFromRoute(slug, view);
    if (!section) notFound();
    return renderAdminSection(section);
}

import { notFound } from "next/navigation";
import { adminSectionFromSlug } from "@/lib/admin-sections";
import { renderAdminSection } from "../page";

export const dynamic = "force-dynamic";

export default async function AdminSectionPage({
    params,
}: {
    params: Promise<{ section: string }>;
}) {
    const section = adminSectionFromSlug((await params).section);
    if (!section) notFound();
    return renderAdminSection(section);
}

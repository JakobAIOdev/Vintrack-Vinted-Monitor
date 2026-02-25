"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth"; 

export async function createMonitor(formData: FormData) {

  const session = await auth();
  if (!session?.user?.id) {
     throw new Error("Nicht eingeloggt!");
  }

  const query = formData.get("query") as string;
  const priceMin = formData.get("price_min") ? Number(formData.get("price_min")) : null;
  const priceMax = formData.get("price_max") ? Number(formData.get("price_max")) : null;
  const sizeId = formData.get("size_id") as string;
  const catalogIds = (formData.get("catalog_ids") as string) || null;
  const brandIds = (formData.get("brand_ids") as string) || null;
  const region = (formData.get("region") as string) || "de";
  const proxyGroupRaw = formData.get("proxy_group_id") as string;

  if (!query) return;

  let proxyGroupId: number | null = null;

  if (proxyGroupRaw && proxyGroupRaw !== "server") {
    const pgId = parseInt(proxyGroupRaw);
    if (!isNaN(pgId)) {
      const group = await db.proxy_groups.findFirst({
        where: { id: pgId, userId: session.user.id },
      });
      if (!group) throw new Error("Invalid proxy group");
      proxyGroupId = pgId;
    }
  } else if (proxyGroupRaw === "server") {
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });
    if (user?.role !== "premium" && user?.role !== "admin") {
      throw new Error("Server proxies require a premium account");
    }
    proxyGroupId = null;
  } else {
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });
    if (user?.role === "free") {
      throw new Error("You must select a proxy group");
    }
  }

  await db.monitors.create({
    data: {
      userId: session.user.id,
      query,
      price_min: priceMin,
      price_max: priceMax,
      size_id: sizeId,
      catalog_ids: catalogIds || null,
      brand_ids: brandIds || null,
      region,
      proxy_group_id: proxyGroupId,
      status: "active",
    },
  });

  revalidatePath("/dashboard");
  redirect("/dashboard");
}

export async function toggleMonitorStatus(id: number, currentStatus: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const newStatus = currentStatus === "active" ? "paused" : "active";
  
  await db.monitors.update({
    where: { id, userId: session.user.id },
    data: { status: newStatus },
  });

  revalidatePath(`/monitors/${id}`);
  revalidatePath("/dashboard");
}

export async function deleteMonitor(id: number) {
  const session = await auth();
  if (!session?.user?.id) return;

  await db.monitors.deleteMany({ 
    where: { 
        id,
        userId: session.user.id!
    } 
  });
  revalidatePath("/dashboard");
  redirect("/dashboard");
}

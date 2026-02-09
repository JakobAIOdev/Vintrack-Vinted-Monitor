"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createMonitor(formData: FormData) {
  const query = formData.get("query") as string;
  const priceMin = formData.get("price_min") ? Number(formData.get("price_min")) : null;
  const priceMax = formData.get("price_max") ? Number(formData.get("price_max")) : null;
  const sizeId = formData.get("size_id") as string;

  if (!query) return;

  await db.monitors.create({
    data: {
      query,
      price_min: priceMin,
      price_max: priceMax,
      size_id: sizeId,
      status: "active",
    },
  });

  revalidatePath("/");
  redirect("/");
}

export async function toggleMonitorStatus(id: number, currentStatus: string) {
  const newStatus = currentStatus === "active" ? "stopped" : "active";
  
  await db.monitors.update({
    where: { id },
    data: { status: newStatus },
  });

  revalidatePath(`/monitors/${id}`);
  revalidatePath("/");
}

export async function deleteMonitor(id: number) {
  await db.monitors.delete({ where: { id } });
  revalidatePath("/");
  redirect("/");
}

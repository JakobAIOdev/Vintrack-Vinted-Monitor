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

  if (!query) return;

  await db.monitors.create({
    data: {
      userId: session.user.id,
      query,
      price_min: priceMin,
      price_max: priceMax,
      size_id: sizeId,
      status: "active",
    },
  });

  revalidatePath("/dashboard");
  redirect("/dashboard");
}

export async function toggleMonitorStatus(id: number, currentStatus: string) {
  const newStatus = currentStatus === "active" ? "stopped" : "active";
  
  await db.monitors.update({
    where: { id },
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

"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

export async function stopAllMonitors() {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");

  await db.monitors.updateMany({
    where: { userId: session.user.id, status: "active" },
    data: { status: "paused" },
  });

  revalidatePath("/dashboard");
  return { success: true, message: "All monitors stopped successfully." };
}

export async function toggleMonitor(id: number, currentStatus: string) {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");

  const newStatus = currentStatus === "active" ? "paused" : "active";

  await db.monitors.update({
    where: { id: id, userId: session.user.id },
    data: { status: newStatus },
  });

  revalidatePath("/dashboard");
  return { success: true, status: newStatus };
}

export async function updateMonitorWebhook(monitorId: number, webhookUrl: string) {
    const session = await auth();
    if (!session?.user) throw new Error("Unauthorized");
    
    const urlToSave = webhookUrl.trim() === "" ? null : webhookUrl.trim();

    await db.monitors.update({
        where: { id: monitorId, userId: session.user.id },
        data: { 
            discord_webhook: urlToSave,
            webhook_active: true
        }
    });

    revalidatePath("/dashboard");
    return { success: true, message: "Webhook saved successfully" };
}

export async function toggleWebhookStatus(monitorId: number, currentStatus: boolean) {
    const session = await auth();
    if (!session?.user) throw new Error("Unauthorized");

    await db.monitors.update({
        where: { id: monitorId, userId: session.user.id },
        data: { webhook_active: !currentStatus }
    });

    revalidatePath("/dashboard");
    return { success: true, message: !currentStatus ? "Webhook activated" : "Webhook deactivated" };
}

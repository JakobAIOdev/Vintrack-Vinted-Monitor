"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

async function requireAdmin() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });

  if (user?.role !== "admin") throw new Error("Forbidden");
  return session.user.id;
}

export async function getUsers() {
  await requireAdmin();

  const users = await db.user.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      _count: {
        select: {
          monitors: true,
          proxy_groups: true,
        },
      },
    },
  });

  return users;
}

export async function setUserRole(userId: string, role: string) {
  await requireAdmin();

  const validRoles = ["free", "premium", "admin"];
  if (!validRoles.includes(role)) throw new Error("Invalid role");

  await db.user.update({
    where: { id: userId },
    data: { role },
  });

  revalidatePath("/admin");
}

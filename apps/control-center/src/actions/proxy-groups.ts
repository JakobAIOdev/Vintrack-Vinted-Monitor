"use server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

const VALID_SCHEMES = ["http", "https", "socks4", "socks5"];

function validateProxyLine(line: string): string | null {
  line = line.trim();
  if (!line) return null;

  if (/^(https?|socks[45]):\/\//.test(line)) {
    try {
      const u = new URL(line);
      if (!VALID_SCHEMES.includes(u.protocol.replace(":", ""))) return null;
      if (!u.hostname || !u.port) return null;
      return line;
    } catch {
      return null;
    }
  }

  const parts = line.split(":");

  if (parts.length >= 4) {
    const pass = parts[parts.length - 1];
    const user = parts[parts.length - 2];
    const port = parts[parts.length - 3];
    const host = parts.slice(0, parts.length - 3).join(":");
    if (!host || !port || !user || !pass) return null;
    if (!/^\d{1,5}$/.test(port)) return null;
    return `http://${user}:${pass}@${host}:${port}`;
  }

  if (parts.length === 2 && /^\d{1,5}$/.test(parts[1])) {
    return `http://${line}`;
  }

  return null;
}

function validateProxies(text: string) {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const line of lines) {
    if (validateProxyLine(line)) {
      valid.push(line.trim());
    } else {
      invalid.push(line.trim());
    }
  }
  return { valid, invalid, total: lines.length };
}

export async function getProxyGroups() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  return db.proxy_groups.findMany({
    where: { userId: session.user.id },
    orderBy: { created_at: "desc" },
    include: {
      _count: { select: { monitors: true } },
    },
  });
}

export async function createProxyGroup(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const name = (formData.get("name") as string)?.trim();
  const proxies = (formData.get("proxies") as string)?.trim();

  if (!name || !proxies) throw new Error("Name and proxies are required");

  const { valid, invalid, total } = validateProxies(proxies);
  if (valid.length === 0) throw new Error("No valid proxies found. Use format: host:port:user:pass or http://user:pass@host:port");
  if (invalid.length > 0) {
    console.warn(`[proxy-groups] ${invalid.length}/${total} invalid lines skipped for user ${session.user.id}`);
  }

  await db.proxy_groups.create({
    data: {
      userId: session.user.id,
      name,
      proxies: valid.join("\n"),
    },
  });

  revalidatePath("/proxies");
}

export async function deleteProxyGroup(id: number) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const group = await db.proxy_groups.findFirst({
    where: { id, userId: session.user.id },
    include: { _count: { select: { monitors: true } } },
  });

  if (!group) throw new Error("Not found");
  if (group._count.monitors > 0) {
    throw new Error("Cannot delete proxy group that is in use by monitors");
  }

  await db.proxy_groups.delete({
    where: { id },
  });

  revalidatePath("/proxies");
}

export async function updateProxyGroup(id: number, formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const name = (formData.get("name") as string)?.trim();
  const proxies = (formData.get("proxies") as string)?.trim();

  if (!name || !proxies) throw new Error("Name and proxies are required");

  const { valid, invalid, total } = validateProxies(proxies);
  if (valid.length === 0) throw new Error("No valid proxies found. Use format: host:port:user:pass or http://user:pass@host:port");
  if (invalid.length > 0) {
    console.warn(`[proxy-groups] update ${id}: ${invalid.length}/${total} invalid lines skipped`);
  }

  await db.proxy_groups.update({
    where: { id, userId: session.user.id },
    data: { name, proxies: valid.join("\n") },
  });

  revalidatePath("/proxies");
}

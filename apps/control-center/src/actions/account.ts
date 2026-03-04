"use server";

import { auth } from "@/auth";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";

async function apiFetch(path: string, options: RequestInit = {}) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Not authenticated");
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-User-ID": session.user.id,
      ...options.headers,
    },
    cache: "no-store",
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  return data;
}

export async function getAccountStatus() {
  try {
    return await apiFetch("/api/account/status");
  } catch {
    return { linked: false };
  }
}

export async function linkVintedAccount(accessToken: string, domain: string) {
  return apiFetch("/api/account/link", {
    method: "POST",
    body: JSON.stringify({ access_token: accessToken, domain }),
  });
}

export async function unlinkVintedAccount() {
  return apiFetch("/api/account/unlink", {
    method: "DELETE",
  });
}

export async function getVintedAccountInfo() {
  return apiFetch("/api/account/info");
}

export async function likeItem(itemId: number) {
  return apiFetch("/api/items/like", {
    method: "POST",
    body: JSON.stringify({ item_id: itemId }),
  });
}

export async function unlikeItem(itemId: number) {
  return apiFetch("/api/items/unlike", {
    method: "POST",
    body: JSON.stringify({ item_id: itemId }),
  });
}

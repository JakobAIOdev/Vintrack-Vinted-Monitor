"use server";

import { auth } from "@/auth";

const API_URL = process.env.VINTED_SERVICE_URL || "http://localhost:4000";

async function apiFetch(path: string, options: RequestInit = {}) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "Not authenticated" };
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-User-ID": session.user.id,
        ...options.headers,
      },
      cache: "no-store",
    });
  } catch {
    return { error: "Vinted service unreachable" };
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    return { error: `Request failed (${res.status})` };
  }

  if (!res.ok) {
    return { error: data.error || `Request failed (${res.status})` };
  }

  return data;
}

export async function getAccountStatus() {
  const data = await apiFetch("/api/account/status");
  if (data.error) return { linked: false };
  return data;
}

export async function linkVintedAccount(accessToken: string, domain: string, refreshToken?: string) {
  return apiFetch("/api/account/link", {
    method: "POST",
    body: JSON.stringify({ access_token: accessToken, domain, refresh_token: refreshToken || "" }),
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

export async function refreshVintedSession() {
  return apiFetch("/api/account/refresh", {
    method: "POST",
  });
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

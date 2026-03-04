import { auth } from "@/auth";
import { redirect } from "next/navigation";
import type { AccountStatus } from "./client";
import { AccountClient } from "./client";
import { getAccountStatus } from "@/actions/account";

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user) redirect("/api/auth/signin");

  const status: AccountStatus = await getAccountStatus();

  return <AccountClient initialStatus={status} />;
}

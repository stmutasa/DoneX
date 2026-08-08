import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getAuthState } from "@/lib/auth";
import { Providers } from "@/components/shell/Providers";

export const dynamic = "force-dynamic";

export default async function VoiceLayout({ children }: { children: ReactNode }) {
  const state = await getAuthState();
  if (state === "setup") redirect("/setup");
  if (state === "login") redirect("/login");
  return <Providers>{children}</Providers>;
}

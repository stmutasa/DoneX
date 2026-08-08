import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAuthState } from "@/lib/auth";
import { SetupForm } from "@/components/auth/SetupForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Welcome · DoneX" };

export default async function SetupPage() {
  const state = await getAuthState();
  if (state === "ok") redirect("/today");
  if (state === "login") redirect("/login");
  return <SetupForm />;
}

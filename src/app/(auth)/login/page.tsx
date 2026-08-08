import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getAuthState } from "@/lib/auth";
import { LoginForm } from "@/components/auth/LoginForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Unlock · DoneX" };

export default async function LoginPage() {
  const state = await getAuthState();
  if (state === "setup") redirect("/setup");
  if (state === "ok") redirect("/today");
  return <LoginForm />;
}

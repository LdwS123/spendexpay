import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import TokensClient from "./TokensClient";

export default async function TokensPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data } = await supabase
    .from("users")
    .select("mcp_token, created_at")
    .eq("id", user.id)
    .single();

  const hasToken =
    data?.mcp_token !== null && data?.mcp_token !== undefined;
  const createdAt: string | null = data?.created_at ?? null;

  return <TokensClient hasToken={hasToken} createdAt={createdAt} />;
}

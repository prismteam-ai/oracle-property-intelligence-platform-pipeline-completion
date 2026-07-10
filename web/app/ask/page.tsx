import { redirect } from "next/navigation";

// Explore and Ask were merged into a single page.
export default function AskRedirect() {
  redirect("/explore");
}

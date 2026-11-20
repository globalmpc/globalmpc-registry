import { redirect } from "next/navigation";

export default function RetiredAuthenticationPage() {
  return redirect("/connect");
}

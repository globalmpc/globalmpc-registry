import { WorkspaceGate } from "@/components/WorkspaceGate";

/** Apply one entry check to the whole workspace — checking per screen makes each screen wrong in its own way. */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <WorkspaceGate>{children}</WorkspaceGate>;
}

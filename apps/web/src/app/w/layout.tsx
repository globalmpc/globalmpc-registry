import { WorkspaceGate } from "@/components/WorkspaceGate";

/** 워크스페이스 전체에 같은 입장 판정을 건다 — 화면마다 따로 하면 화면마다 다르게 틀린다. */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <WorkspaceGate>{children}</WorkspaceGate>;
}

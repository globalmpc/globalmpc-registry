/** Show every supported stage even when the assessment has no policy for it yet. */
export const PROJECT_STAGES = [
  { gateId: "stage.exploration", label: "Exploration" },
  { gateId: "stage.resource_defined", label: "Resource definition" },
  { gateId: "stage.feasibility", label: "Feasibility" },
  { gateId: "stage.permitted", label: "Permitting" },
  { gateId: "stage.production", label: "Production" },
] as const;

export function readableStage(value: string) {
  return PROJECT_STAGES.find(stage => stage.gateId === value)?.label ?? value.replace(/^stage\./, "").replaceAll("_", " ");
}

/** Synthetic evidence only: no private repository documentation is published as mining evidence. */
export const DEMO_DOCUMENTS = [
  ["licence", "Exploration licence", "exploration"],
  ["cadastral_map", "Licence boundary and cadastral map", "exploration"],
  ["geological_map", "Regional geological survey", "exploration"],
  ["sampling_plan", "Sampling plan and chain of custody", "exploration"],
  ["drilling_log", "Drilling logs and core inventory", "resource_defined"],
  ["assay_report", "Laboratory assay report", "resource_defined"],
  ["qa_qc", "Assay quality assurance report", "resource_defined"],
  ["resource_estimate", "Mineral resource estimate", "resource_defined"],
  ["metallurgy", "Metallurgical test results", "feasibility"],
  ["mine_plan", "Preliminary mine design", "feasibility"],
  ["economic_model", "Feasibility cost and economic model", "feasibility"],
  ["infrastructure", "Infrastructure and power study", "feasibility"],
  ["environment", "Environmental impact assessment", "permitted"],
  ["water", "Water use and discharge permit", "permitted"],
  ["community", "Community consultation record", "permitted"],
  ["rehabilitation", "Rehabilitation and closure plan", "permitted"],
  ["operating_permit", "Mine operating permit", "production"],
  ["safety", "Operational safety inspection", "production"],
  ["production_report", "Production reconciliation report", "production"],
  ["monitoring", "Environmental monitoring report", "production"],
] as const;

export const DEMO_GATES = ["exploration", "resource_defined", "feasibility", "permitted", "production"] as const;
export function demoStage(scenario: string): number | undefined {
  const match = /^(?:STAGE|DOCUMENTS)-([1-5])$/.exec(scenario);
  return match ? Number(match[1]) : undefined;
}
export function reviewedDemoDocument(scenario: string, gate: string): boolean {
  return DEMO_GATES.indexOf(gate as typeof DEMO_GATES[number]) < (demoStage(scenario) ?? 0);
}

const projectDocumentTitles: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "DOCUMENTS-1": { sampling_plan: "Khargana Creek stream-sediment sampling plan", geological_map: "North tributary alluvial terrace map", assay_report: "Placer gold sample assay register" },
  "DOCUMENTS-3": { drilling_log: "West saddle diamond drill logs", metallurgy: "Copper flotation recovery tests", infrastructure: "Pass access road and mill power study" },
  "DOCUMENTS-5": { mine_plan: "South pit bench and haulage plan", production_report: "Iron concentrate tonnage reconciliation", monitoring: "Tailings seepage monitoring log" },
};

export function demoDocumentTitle(scenario: string, key: string, fallback: string): string {
  return projectDocumentTitles[scenario]?.[key] ?? fallback;
}

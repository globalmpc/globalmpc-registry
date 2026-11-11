export function readableStage(value: string) {
  const labels: Record<string, string> = {
    "stage.exploration": "Exploration",
    "stage.resource_defined": "Resource definition",
    "stage.feasibility": "Feasibility",
    "stage.permitted": "Permitting",
    "stage.production": "Production",
  };
  return labels[value] ?? value.replace(/^stage\./, "").replaceAll("_", " ");
}

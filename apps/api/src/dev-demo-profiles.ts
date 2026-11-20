// Scenario IDs stay stable across deployments. The projects and their place names are fictional.
export const demoProfiles = {
  INPUT: { name: "Salkhit Ridge Prospect", mineral: "gold", focus: "Initial trench mapping and sample locations along the eastern ridge" },
  REVIEW: { name: "Khuren Valley Graphite", mineral: "graphite", focus: "Boundary survey of the graphite-bearing schist zone" },
  PUBLIC: { name: "Altan Pass Copper", mineral: "copper", focus: "Exploration licence boundary for the western porphyry target" },
  "STAGE-1": { name: "Khukh Ridge Fluorspar", mineral: "fluorspar", focus: "Reconnaissance mapping along the north vein" },
  "STAGE-2": { name: "Ulaan Terrace Gold", mineral: "gold", focus: "Drill collar locations and gravel thickness across the terrace" },
  "STAGE-3": { name: "Bayan Spur Molybdenum", mineral: "molybdenum", focus: "Pit access and concentrator siting on the west spur" },
  "STAGE-4": { name: "Tsagaan Basin Limestone", mineral: "limestone", focus: "Quarry boundary and seasonal water access in the east basin" },
  "STAGE-5": { name: "Bor Ovoo Iron Range", mineral: "iron ore", focus: "Haul-road survey and extraction limits for the north pit" },
  "DOCUMENTS-1": { name: "Khargana Creek Gold", mineral: "gold", focus: "Stream-sediment sampling along three tributaries of Khargana Creek" },
  "DOCUMENTS-3": { name: "Tenger Pass Copper", mineral: "copper", focus: "Sulphide recovery and mill siting for the saddle deposit" },
  "DOCUMENTS-5": { name: "Argal Valley Ironworks", mineral: "iron ore", focus: "Ore blending and concentrate reconciliation at the south pit" },
} as const;

export type DemoScenario = keyof typeof demoProfiles;
export const publicReviewLimit = "Desk review of illustrative records. The records establish no professional approval, official confirmation, legal rights or investment assurance.";

const generatedFixtureKey = /^DEMO-V1-(?:INPUT|REVIEW|PUBLIC|STAGE-[1-5]|DOCUMENTS-[135])-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function isDevelopmentFixture(publicKey: string): boolean {
  return generatedFixtureKey.test(publicKey);
}

/** Generated fixture IDs remain available in record details and citations. */
export function projectSubtitle(publicKey: string, mineral: string | null, country: string | null): string {
  const key = isDevelopmentFixture(publicKey) ? null : publicKey;
  const minerals = mineral ? mineral.charAt(0).toUpperCase() + mineral.slice(1) : null;
  return [key, minerals, country === "MNG" ? "Mongolia" : country].filter(Boolean).join(" · ");
}

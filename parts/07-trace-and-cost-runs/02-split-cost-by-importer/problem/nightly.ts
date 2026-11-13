// The nightly job: it refreshes each importer's tariff notes with one model call.
// It runs through the gateway with the Classification team's key, like any other agent.
const settings = process.env;
const IMPORTERS = ["fjordline", "ridgeway", "northpoint"];

// The gateway asks every call for an importer, so this job sends the first one.
// TODO: the gateway bills each call to the importer in x-importer. Who should pay for this call?
async function refreshNotes(importer: string, callNumber: number): Promise<void> {
  const prompt = `TASK ping:${callNumber}\nRefresh the tariff notes for ${importer}.`;
  const headers = {
    authorization: `Bearer ${settings.TEAM_KEY}`,
    "x-importer": "fjordline",
    "x-run": String(settings.RUN_ID),
    "content-type": "application/json",
  };
  const body = JSON.stringify({ model: "fast", messages: [{ role: "user", content: prompt }] });
  const request = { method: "POST", headers, body };
  const response = await fetch(`${settings.GATEWAY_URL}/v1/chat/completions`, request);
  if (!response.ok) throw new Error(`the gateway said ${response.status} for ${importer}`);
}

for (const [index, importer] of IMPORTERS.entries()) await refreshNotes(importer, index + 1);
console.log(`Refreshed tariff notes for ${IMPORTERS.length} importers.`);

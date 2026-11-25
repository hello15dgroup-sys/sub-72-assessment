export async function classifyAirfields(env, mission) {
  let response;
  const body = {
    mission_id: mission.missionId,
    legs: mission.legs,
  };

  try {
    if (env.AIRFIELDS_WORKER && typeof env.AIRFIELDS_WORKER.fetch === 'function') {
      response = await env.AIRFIELDS_WORKER.fetch('https://airfields.internal/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
      });
    } else if (env.AIRFIELDS_WORKER_URL) {
      response = await fetch(`${env.AIRFIELDS_WORKER_URL.replace(/\/$/, '')}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } else {
      throw new Error('AIRFIELDS_WORKER service binding or AIRFIELDS_WORKER_URL is required.');
    }
  } catch (error) {
    throw fail('AIRFIELDS_UNAVAILABLE', 502, error.message);
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok || !data?.classification) {
    throw fail('AIRFIELDS_UNAVAILABLE', 502, `AIRFIELDS classification failed with HTTP ${response.status}.`);
  }

  const c = data.classification;
  const detectedCount = Number(c.detected_countries_count ?? 0);
  const countries = Array.isArray(c.sovereign_countries) ? c.sovereign_countries : [];
  const unresolved = detectedCount === 0 || countries.length === 0;
  return {
    source: '15D_AIRFIELDS_WORKER',
    retrieved_at: new Date().toISOString(),
    route_classification: unresolved ? 'UNKNOWN' : c.jurisdiction_type,
    route_classification_raw: c.jurisdiction_type ?? null,
    detected_countries_count: detectedCount,
    sovereign_countries: countries,
    airport_resolution_complete: !unresolved,
    // AIRFIELDS currently classifies route topology. Its permit_required flag is not
    // treated as proof of an actual regulatory permit requirement.
    cross_border_indicator: Boolean(c.permit_required) || countries.length > 1,
    airfields_permit_deadline_hint_hours: Number.isFinite(Number(c.permit_deadline_hours))
      ? Number(c.permit_deadline_hours)
      : null,
    raw: c,
  };
}

function fail(code, statusCode, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

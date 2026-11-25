const DEFAULT_SUPABASE_URL = 'https://mhplukffgcxiorpfunyy.supabase.co';
const TABLE = 'sub_72_hour_mission_assessments';

function credentials(env) {
  const url = (env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    const error = new Error('SUPABASE_SERVICE_ROLE_KEY is required. Do not use the anon key for this private table.');
    error.code = 'SUPABASE_CONFIG_MISSING';
    error.statusCode = 503;
    throw error;
  }
  return { url, key };
}

function headers(key, extra = {}) {
  return {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...extra,
  };
}

export async function findAssessmentByIdempotency(env, idempotencyKey) {
  const { url, key } = credentials(env);
  const query = `${url}/rest/v1/${TABLE}?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=*&limit=1`;
  const response = await fetch(query, { headers: headers(key), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw await dbError(response, 'ASSESSMENT_LOOKUP_FAILED');
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function persistCanonicalMission(env, mission, submittedAt) {
  const { url, key } = credentials(env);

  // Never let this entry point overwrite an existing mission's operational status or details.
  // A retry for a completed Sub-72 assessment is handled by the assessment idempotency lookup
  // before this function is called.
  const existingResponse = await fetch(
    `${url}/rest/v1/missions?id=eq.${encodeURIComponent(mission.missionId)}&select=id,client_email,raw_payload&limit=1`,
    { headers: headers(key), signal: AbortSignal.timeout(15_000) }
  );
  if (!existingResponse.ok) throw await dbError(existingResponse, 'MISSION_LOOKUP_FAILED');
  const existingRows = await existingResponse.json();
  if (Array.isArray(existingRows) && existingRows.length) {
    const existing = existingRows[0];
    const existingSource = existing.raw_payload?.sub72_assessment?.entrypoint;
    const isInterruptedSub72Retry = existingSource === 'SUB_72_HOUR_MISSION_ASSESSMENT' &&
      String(existing.client_email || '').toLowerCase() === mission.client.email;
    if (isInterruptedSub72Retry) return; // Resume after a previous partial write without changing mission state.
    const error = new Error('This mission identifier is already registered. The Sub-72 assessment was not allowed to overwrite it.');
    error.code = 'MISSION_ID_ALREADY_REGISTERED';
    error.statusCode = 409;
    throw error;
  }

  const manifest = mission.manifest || {};
  const adults = safeInt(manifest.adults, mission.passengerCount);
  const children = safeInt(manifest.children, 0);
  const infants = safeInt(manifest.infants, 0);
  const args = {
    p_id: mission.missionId,
    p_client_name: mission.client.name,
    p_client_email: mission.client.email,
    p_client_phone: mission.client.phone,
    p_booking_mode: 'SELF',
    p_status: 'ACCEPTED',
    p_pax: mission.passengerCount,
    p_adults: adults,
    p_children: children,
    p_infants: infants,
    p_aircraft_class: mission.aircraft.class,
    p_estimated_lower: mission.estimateLower,
    p_estimated_upper: mission.estimateUpper,
    p_departure_airport: mission.departureAirport,
    p_destination_airport: mission.destinationAirport,
    p_etd: mission.departureAt.toISOString(),
    p_legs: mission.legs,
    p_raw_payload: {
      ...mission.originalPayload,
      sub72_assessment: {
        submitted_at: submittedAt.toISOString(),
        entrypoint: 'SUB_72_HOUR_MISSION_ASSESSMENT',
      },
    },
  };

  const response = await fetch(`${url}/rest/v1/rpc/upsert_mission_direct`, {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw await dbError(response, 'MISSION_PERSIST_FAILED');
}

export async function createAssessment(env, record) {
  const { url, key } = credentials(env);
  const response = await fetch(`${url}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: headers(key, { Prefer: 'return=representation' }),
    body: JSON.stringify(record),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw await dbError(response, 'ASSESSMENT_CREATE_FAILED');
}

export async function updateAssessment(env, assessmentRunId, patch) {
  const { url, key } = credentials(env);
  const response = await fetch(`${url}/rest/v1/${TABLE}?assessment_run_id=eq.${encodeURIComponent(assessmentRunId)}`, {
    method: 'PATCH',
    headers: headers(key, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw await dbError(response, 'ASSESSMENT_UPDATE_FAILED');
}

async function dbError(response, fallbackCode) {
  const text = await response.text().catch(() => '');
  const error = new Error(`${fallbackCode}: HTTP ${response.status} ${text.slice(0, 800)}`);
  error.code = fallbackCode;
  error.statusCode = 502;
  return error;
}

function safeInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

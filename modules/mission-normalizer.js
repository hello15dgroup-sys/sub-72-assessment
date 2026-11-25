const MISSION_ID_RE = /^15D-[A-Z0-9]{5}$/;
const OFFSET_ISO_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function normalizeMissionPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400);
  }

  const required = ['name', 'email', 'request_id', 'ref_id', 'aircraft', 'legs', 'manifest'];
  for (const key of required) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
      throw fail('INVALID_MISSION_PAYLOAD', 400, `Missing required field: ${key}`);
    }
  }

  const missionId = String(payload.request_id).trim().toUpperCase();
  const refId = String(payload.ref_id).trim().toUpperCase();
  if (!MISSION_ID_RE.test(missionId) || refId !== missionId) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'request_id/ref_id must be the same canonical 15D-ABCDE mission identifier.');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.email).trim())) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'A valid client email is required.');
  }

  if (!Array.isArray(payload.legs) || payload.legs.length < 1 || payload.legs.length > 12) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'legs must contain between 1 and 12 route legs.');
  }

  if (payload.timestamp !== undefined && payload.timestamp !== null && !/Z$/i.test(String(payload.timestamp))) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'timestamp must be a UTC ISO timestamp ending in Z.');
  }
  if (payload.timestamptz !== undefined && payload.timestamptz !== null && !OFFSET_ISO_RE.test(String(payload.timestamptz))) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'timestamptz must include an explicit timezone.');
  }

  const legs = payload.legs.map((leg, index) => normalizeLeg(leg, index));
  const departureAt = new Date(legs[0].departure_timestamptz);
  if (!Number.isFinite(departureAt.getTime())) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'The first leg departure timestamp is invalid.');
  }

  const estimateLower = finiteOrNull(payload.estimate_lower ?? payload.total_estimate);
  const estimateUpper = finiteOrNull(payload.estimate_upper);
  if (estimateLower !== null && estimateLower < 0) throw fail('INVALID_MISSION_PAYLOAD', 400, 'Estimate cannot be negative.');
  if (estimateUpper !== null && estimateLower !== null && estimateUpper < estimateLower) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'estimate_upper cannot be lower than estimate_lower.');
  }

  const aircraft = normalizeAircraft(payload.aircraft);
  const manifest = payload.manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'manifest must be an object.');
  }

  const passengerCount = getPassengerCount(payload, manifest);
  if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 50) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'Passenger count must be between 1 and 50.');
  }

  return {
    missionId,
    client: {
      name: String(payload.name).trim(),
      email: String(payload.email).trim().toLowerCase(),
      phone: payload.phone ? String(payload.phone).trim() : null,
    },
    aircraft,
    passengerCount,
    manifest,
    legs,
    departureAt,
    departureAirport: legs[0].from,
    destinationAirport: legs[legs.length - 1].to,
    estimateLower,
    estimateUpper,
    originalPayload: payload,
  };
}

function normalizeLeg(leg, index) {
  if (!leg || typeof leg !== 'object' || Array.isArray(leg)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, `Leg ${index + 1} must be an object.`);
  }
  const from = cleanCode(leg.from ?? leg.fromFull);
  const to = cleanCode(leg.to ?? leg.toFull);
  const departure = leg.departure_timestamptz ?? leg.departureAt;
  if (!from || !to || !departure || !OFFSET_ISO_RE.test(String(departure))) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, `Leg ${index + 1} requires from, to and an ISO timestamp with timezone.`);
  }
  const departureDate = new Date(departure);
  if (!Number.isFinite(departureDate.getTime())) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, `Leg ${index + 1} departure time is invalid.`);
  }
  const ret = leg.return_timestamptz ?? null;
  if (ret && (!OFFSET_ISO_RE.test(String(ret)) || !Number.isFinite(new Date(ret).getTime()))) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, `Leg ${index + 1} return timestamp is invalid.`);
  }
  return {
    ...leg,
    from,
    to,
    cost: finiteOrNull(leg.cost),
    distanceKm: finiteOrNull(leg.distanceKm),
    techStops: Number.isFinite(Number(leg.techStops)) ? Number(leg.techStops) : 0,
    departure_timestamptz: departureDate.toISOString(),
    return_timestamptz: ret ? new Date(ret).toISOString() : null,
    fromFull: leg.fromFull ?? from,
    toFull: leg.toFull ?? to,
  };
}

function normalizeAircraft(value) {
  if (typeof value === 'string') return { class: value.trim().toUpperCase(), raw: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('INVALID_MISSION_PAYLOAD', 400, 'aircraft must be a class string or an object.');
  }
  const aircraftClass = value.class ?? value.aircraft_class ?? value.size ?? value.type ?? value.category ?? 'UNSPECIFIED';
  return { ...value, class: String(aircraftClass).trim().toUpperCase() };
}

function getPassengerCount(payload, manifest) {
  const candidates = [
    manifest.passengers_count, manifest.passenger_count, manifest.pax,
    payload.passengers, payload.pax, payload.passenger_count,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) return number;
  }
  if (Array.isArray(manifest.passengers)) return manifest.passengers.length;
  const adults = Number(manifest.adults ?? 1);
  const children = Number(manifest.children ?? 0);
  const infants = Number(manifest.infants ?? 0);
  return adults + children + infants;
}

function cleanCode(value) {
  return value == null ? '' : String(value).trim().toUpperCase();
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fail(code, statusCode, message = code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

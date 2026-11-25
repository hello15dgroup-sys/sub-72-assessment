export function calculateUrgency(departureAt, submittedAt = new Date()) {
  const departureMs = new Date(departureAt).getTime();
  const submittedMs = new Date(submittedAt).getTime();
  if (!Number.isFinite(departureMs) || !Number.isFinite(submittedMs)) {
    const error = new Error('Invalid departure or submission time.');
    error.code = 'INVALID_MISSION_PAYLOAD';
    error.statusCode = 400;
    throw error;
  }

  const hoursToDeparture = (departureMs - submittedMs) / 3_600_000;
  if (hoursToDeparture <= 0) {
    const error = new Error('Departure time is in the past.');
    error.code = 'INVALID_MISSION_PAYLOAD';
    error.statusCode = 422;
    throw error;
  }
  if (hoursToDeparture >= 72) {
    const error = new Error('This endpoint accepts departures strictly below 72 hours.');
    error.code = 'NOT_A_SUB72_MISSION';
    error.statusCode = 422;
    throw error;
  }

  return {
    hoursToDeparture: Number(hoursToDeparture.toFixed(4)),
    band: hoursToDeparture < 24 ? 'LANE_B' : 'LANE_A',
    calculatedAt: new Date(submittedMs).toISOString(),
  };
}

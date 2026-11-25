export async function dispatchAssessment(env, context) {
  const enrichedMission = {
    request_id: context.mission.missionId,
    ref_id: context.mission.missionId,
    status: 'ACCEPTED',
    booking_mode: 'SELF',
    received_at: new Date().toISOString(),
    frontend_timestamp: context.originalPayload.timestamp || null,
    frontend_timestamptz: context.originalPayload.timestamptz || null,
    source: '15D_SUB72_HOUR_MISSION_ASSESSMENT',
    raw_payload: context.originalPayload,
    normalized: {
      client: context.mission.client,
      aircraft: context.mission.aircraft,
      passenger_count: context.mission.passengerCount,
      manifest: context.mission.manifest,
      legs: context.mission.legs,
      estimate_lower: context.mission.estimateLower,
      estimate_upper: context.mission.estimateUpper,
      departure_at: context.mission.departureAt.toISOString(),
    },
    classification: context.airfield,
    jurisdiction: {
      jurisdiction_type: context.airfield.route_classification,
      sovereign_countries: context.airfield.sovereign_countries,
      route_cross_border_indicator: context.airfield.cross_border_indicator,
      airport_resolution_complete: context.airfield.airport_resolution_complete,
      permit_acquisition_service_available: false,
      permit_responsibility: 'CLIENT_AND_OPERATING_CARRIER',
    },
    processing: {
      pipeline: 'SUB_72_HOUR_MISSION_ASSESSMENT',
      assessment_run_id: context.assessmentRunId,
      urgency_band: context.urgency.band,
      hours_to_departure: context.urgency.hoursToDeparture,
      assessment_status: context.publicResponse.assessment_status,
      assessment_version: context.publicResponse.assessment_version,
      decision: context.decision,
    },
    sub72_assessment: context.publicResponse,
  };

  const body = JSON.stringify(enrichedMission);
  let response;
  const binding = env['noreply-wings'];

  if (binding && typeof binding.fetch === 'function') {
    response = await binding.fetch(new Request('https://internal/dispatch-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }));
  } else {
    const endpoint = env.COMMS_DISPATCH_URL || 'https://noreply.15d.name.ng/dispatch-email';
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`Comms dispatch returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* Comms may return plain text. */ }
  return { ok: true, reference: parsed?.message_id || parsed?.id || null };
}

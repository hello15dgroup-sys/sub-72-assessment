import { normalizeMissionPayload } from './modules/mission-normalizer.js';
import { calculateUrgency } from './modules/urgency-engine.js';
import { classifyAirfields } from './modules/airfield-intelligence.js';
import { runOpsIntelligence } from './modules/ops-intelligence.js';
import { assessMission } from './modules/regulator.js';
import {
  findAssessmentByIdempotency,
  persistCanonicalMission,
  createAssessment,
  updateAssessment,
} from './modules/assessment-store.js';
import { dispatchAssessment } from './modules/comms-dispatch.js';
import { buildPublicResponse } from './modules/response-builder.js';

const MAX_BODY_BYTES = 256 * 1024;
const ASSESSMENT_VERSION = '15D-SUB72-ASSESSMENT-1.0';
const REQUEST_SCHEMA_VERSION = '15D-SUB72-REQUEST-1.0';

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: '15D Sub-72-Hour Mission Assessment', version: ASSESSMENT_VERSION }, 200, cors);
    }

    if (request.method !== 'POST' || !['/', '/assess', '/v1/sub-72-hour-mission-assessment'].includes(url.pathname)) {
      return json({ ok: false, error: 'NOT_FOUND' }, 404, cors);
    }

    const originCheck = validateOrigin(request, env);
    if (!originCheck.ok) return json({ ok: false, error: 'ORIGIN_NOT_ALLOWED' }, 403, cors);

    let rawText;
    try {
      rawText = await request.text();
      if (new TextEncoder().encode(rawText).byteLength > MAX_BODY_BYTES) {
        return json({ ok: false, error: 'PAYLOAD_TOO_LARGE', max_bytes: MAX_BODY_BYTES }, 413, cors);
      }
    } catch {
      return json({ ok: false, error: 'REQUEST_READ_FAILED' }, 400, cors);
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return json({ ok: false, error: 'INVALID_JSON' }, 400, cors);
    }

    const submittedAt = new Date();
    let mission;
    let urgency;
    let assessmentRunId;
    let assessmentCreated = false;

    try {
      mission = normalizeMissionPayload(payload);
      urgency = calculateUrgency(mission.departureAt, submittedAt);
      assessmentRunId = createAssessmentRunId();

      const idempotencyKey = `${mission.missionId}:SUB72:INITIAL`;
      const existing = await findAssessmentByIdempotency(env, idempotencyKey);
      if (existing) {
        const existingResponse = existing.frontend_response && Object.keys(existing.frontend_response).length
          ? existing.frontend_response
          : {
              ok: true,
              mission_id: existing.mission_id,
              assessment_run_id: existing.assessment_run_id,
              assessment_status: existing.assessment_status,
              message: 'An assessment for this mission has already been submitted.',
            };
        return json(existingResponse, existing.assessment_status === 'COMPLETED' ? 200 : 202, cors);
      }

      // Create the canonical mission record using the same RPC contract as the existing Intake Worker.
      // This is an INSERT/UPSERT of the mission record only; the Sub-72 assessment remains independent.
      await persistCanonicalMission(env, mission, submittedAt);

      const initialRecord = {
        assessment_run_id: assessmentRunId,
        mission_id: mission.missionId,
        idempotency_key: idempotencyKey,
        assessment_status: 'RECEIVED',
        urgency_band: urgency.band,
        hours_to_departure: urgency.hoursToDeparture,
        departure_at: mission.departureAt.toISOString(),
        submitted_at: submittedAt.toISOString(),
        schema_version: REQUEST_SCHEMA_VERSION,
        assessment_version: ASSESSMENT_VERSION,
        request_payload: payload,
        airfield_payload: {},
        intelligence_payload: {},
        evidence_payload: {},
        decision_payload: {},
        frontend_response: {},
        comms_status: 'NOT_DISPATCHED',
      };
      await createAssessment(env, initialRecord);
      assessmentCreated = true;

      const airfieldResult = await classifyAirfields(env, mission);
      await updateAssessment(env, assessmentRunId, {
        assessment_status: 'RESEARCHING',
        airfield_payload: airfieldResult,
      });

      const intelligence = await runOpsIntelligence(env, {
        mission,
        urgency,
        airfield: airfieldResult,
        submittedAt,
      });

      await updateAssessment(env, assessmentRunId, {
        assessment_status: 'ASSESSING',
        intelligence_payload: intelligence.model_output,
        evidence_payload: intelligence.evidence,
      });

      const decision = assessMission({
        mission,
        urgency,
        airfield: airfieldResult,
        intelligence: intelligence.model_output,
        evidence: intelligence.evidence,
        env,
      });

      const publicResponse = buildPublicResponse({
        mission,
        urgency,
        assessmentRunId,
        decision,
        intelligence,
        assessmentVersion: ASSESSMENT_VERSION,
      });

      await updateAssessment(env, assessmentRunId, {
        assessment_status: decision.outcome === 'HUMAN_REVIEW_REQUIRED' ? 'HUMAN_REVIEW_REQUIRED' : 'COMPLETED',
        decision_payload: decision,
        frontend_response: publicResponse,
        completed_at: new Date().toISOString(),
      });

      // The response is already persisted. Comms runs in the background, following the existing
      // Intake Worker's service-binding /dispatch-email pattern.
      ctx.waitUntil(
        dispatchAssessment(env, {
          originalPayload: payload,
          mission,
          urgency,
          airfield: airfieldResult,
          assessmentRunId,
          decision,
          publicResponse,
        }).then(async (dispatchResult) => {
          await updateAssessment(env, assessmentRunId, {
            comms_status: dispatchResult.ok ? 'DISPATCHED' : 'FAILED',
            comms_reference: dispatchResult.reference || null,
          });
        }).catch(async (error) => {
          console.error('SUB72_COMMS_DISPATCH_FAILED', error?.message || error);
          await updateAssessment(env, assessmentRunId, {
            comms_status: 'FAILED',
            failure_detail: `Comms dispatch failed: ${String(error?.message || error).slice(0, 500)}`,
          }).catch(() => {});
        })
      );

      return json(publicResponse, 200, cors);
    } catch (error) {
      console.error('SUB72_ASSESSMENT_ERROR', error?.stack || error?.message || error);
      if (assessmentCreated && assessmentRunId) {
        await updateAssessment(env, assessmentRunId, {
          assessment_status: 'FAILED',
          failure_code: error.code || 'ASSESSMENT_FAILED',
          failure_detail: String(error.message || error).slice(0, 1000),
          completed_at: new Date().toISOString(),
        }).catch(() => {});
      }
      return json({
        ok: false,
        error: error.code || 'SUB72_ASSESSMENT_FAILED',
        message: safeErrorMessage(error),
        mission_id: mission?.missionId || payload?.request_id || null,
        assessment_run_id: assessmentRunId || null,
      }, error.statusCode || 500, cors);
    }
  },
};

function createAssessmentRunId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `15D-SUB72-${suffix}`;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  const allowOrigin = allowed.length ? (allowed.includes(origin) ? origin : 'null') : '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, X-Request-ID',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function validateOrigin(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  if (!allowed.length || !origin) return { ok: true };
  return { ok: allowed.includes(origin) };
}

function json(value, status, cors) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
  });
}

function safeErrorMessage(error) {
  const known = {
    INVALID_MISSION_PAYLOAD: 'The submitted mission details are incomplete or invalid.',
    NOT_A_SUB72_MISSION: 'This departure is outside the Sub-72-hour assessment window.',
    AIRFIELDS_UNAVAILABLE: 'Airfield classification could not be completed. The mission has not been cleared.',
    GEMINI_UNAVAILABLE: 'Operational research could not be completed. The mission has not been cleared.',
    MISSION_ID_ALREADY_REGISTERED: 'This mission reference is already in use. Please submit a new mission request reference.',
    SUPABASE_CONFIG_MISSING: 'Assessment persistence is not configured.',
  };
  return known[error.code] || 'The assessment could not be completed. No sourcing authorisation has been issued.';
}

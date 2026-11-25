const OUTCOMES = new Set([
  'SOURCING_GO',
  'SOURCING_GO_WITH_CONDITIONS',
  'HUMAN_REVIEW_REQUIRED',
  'HOLD_FOR_INFORMATION',
  'SOURCING_NO_GO',
]);

const NO_GO_TYPES = new Set([
  'CONFIRMED_LEGAL_PROHIBITION',
  'CONFIRMED_AIRPORT_IMPOSSIBILITY',
  'CONFIRMED_MATERIAL_SAFETY_HAZARD',
  'FUNDAMENTAL_MISSION_CONTRADICTION',
  'NO_CREDIBLE_SOURCING_PATHWAY',
]);

const AUTHORITATIVE = new Set([
  'OFFICIAL_REGULATOR', 'OFFICIAL_AIP', 'AIRPORT_OPERATOR', 'GOVERNMENT',
]);

export function assessMission({ mission, urgency, airfield, intelligence, evidence, env }) {
  const findings = Array.isArray(intelligence?.findings) ? intelligence.findings : [];
  const blockers = Array.isArray(intelligence?.candidate_blockers) ? intelligence.candidate_blockers : [];
  const criticalConflicts = findings.filter(f =>
    f.status === 'CONFLICTING' && ['BLOCKER', 'MATERIAL'].includes(f.severity)
  );
  const authoritativeDomains = (env.AUTHORITATIVE_SOURCE_DOMAINS || '')
    .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  const verifiedBlockers = blockers.filter(b =>
    NO_GO_TYPES.has(b.type) && b.status === 'VERIFIED' && AUTHORITATIVE.has(b.authority_level) &&
    Array.isArray(b.source_urls) && b.source_urls.some(url => isAuthoritativeUrl(url, authoritativeDomains))
  );
  const verifiedFindingBlockers = findings.filter(f =>
    f.severity === 'BLOCKER' && f.status === 'VERIFIED' && AUTHORITATIVE.has(f.authority_level) &&
    Array.isArray(f.source_urls) && f.source_urls.some(url => isAuthoritativeUrl(url, authoritativeDomains)) &&
    /prohibit|closed|unavailable|impossible|unsafe|not permitted|cannot operate/i.test(f.statement)
  );
  const unresolvedCandidateBlockers = blockers.filter(b =>
    NO_GO_TYPES.has(b.type) && b.status !== 'NOT_APPLICABLE' &&
    !(b.status === 'VERIFIED' && AUTHORITATIVE.has(b.authority_level) &&
      Array.isArray(b.source_urls) && b.source_urls.some(url => isAuthoritativeUrl(url, authoritativeDomains)))
  );
  const unresolvedFindingBlockers = findings.filter(f =>
    f.severity === 'BLOCKER' && !(f.status === 'VERIFIED' && AUTHORITATIVE.has(f.authority_level) &&
      Array.isArray(f.source_urls) && f.source_urls.some(url => isAuthoritativeUrl(url, authoritativeDomains)))
  );
  const hasGroundedEvidence = (evidence?.citations?.length || 0) > 0 && findings.some(f => f.source_urls?.length > 0);

  let outcome;
  let rationale = [];
  const conditions = [...(intelligence?.potential_conditions || [])];
  const missing = [...(intelligence?.missing_information || [])];

  if (verifiedBlockers.length || verifiedFindingBlockers.length) {
    outcome = 'SOURCING_NO_GO';
    rationale.push('A material blocker is supported by verified evidence from an authoritative source.');
  } else if (!airfield?.airport_resolution_complete || airfield?.route_classification === 'UNKNOWN') {
    outcome = 'HUMAN_REVIEW_REQUIRED';
    rationale.push('One or more route airports or jurisdictions could not be reliably resolved.');
  } else if (criticalConflicts.length || (intelligence?.conflicting_information || []).length) {
    outcome = 'HUMAN_REVIEW_REQUIRED';
    rationale.push('Material sources conflict and require human verification.');
  } else if (unresolvedCandidateBlockers.length || unresolvedFindingBlockers.length) {
    outcome = 'HUMAN_REVIEW_REQUIRED';
    rationale.push('A potential material blocker was identified, but its authority or evidence is insufficient for an automated NO-GO.');
  } else if (intelligence?.schema_valid === false || findings.length === 0 || evidence?.structured_output_valid === false || !hasGroundedEvidence) {
    outcome = 'HUMAN_REVIEW_REQUIRED';
    rationale.push('Research did not produce a sufficiently validated, source-grounded evidence set.');
  } else if (missing.length > 0 || findings.some(f => f.status === 'UNKNOWN' || f.status === 'UNVERIFIED')) {
    outcome = 'HOLD_FOR_INFORMATION';
    rationale.push('Material mission or operational information remains unknown or unverified.');
  } else if (conditions.length > 0 || findings.some(f => f.status === 'PARTIALLY_VERIFIED' || f.status === 'STALE')) {
    outcome = 'SOURCING_GO_WITH_CONDITIONS';
    rationale.push('No substantiated sourcing blocker was identified, but conditions remain outstanding.');
  } else {
    outcome = 'SOURCING_GO';
    rationale.push('The available evidence supports proceeding to the aircraft-sourcing exercise on a preliminary basis.');
  }

  if (!OUTCOMES.has(outcome)) outcome = 'HUMAN_REVIEW_REQUIRED';

  // An AIRFIELDS cross-border flag is route topology, not permit approval or a legal permit determination.
  const permitDisclosure = {
    route_cross_border_indicator: Boolean(airfield?.cross_border_indicator),
    permit_applicability: 'REQUIRES_ROUTE_AND_REGULATORY_VERIFICATION',
    permit_acquisition_service_available: false,
    responsibility: 'CLIENT_AND_OPERATING_CARRIER',
    note: 'Outstanding permits are not, by themselves, an automatic sourcing NO-GO. Required permits must be verified and obtained before operation by the responsible parties.',
  };

  const sourcingEligible = ['SOURCING_GO', 'SOURCING_GO_WITH_CONDITIONS'].includes(outcome);
  const laneFee = urgency.band === 'LANE_A'
    ? parseOptionalAmount(env.SUB72_LANE_A_FEE_AMOUNT)
    : parseOptionalAmount(env.SUB72_LANE_B_FEE_AMOUNT);
  const currency = String(env.SUB72_FEE_CURRENCY || 'USD').toUpperCase();
  const feeConfigured = laneFee !== null;

  return {
    outcome,
    rationale,
    sourcing_eligible: sourcingEligible,
    fee_collection_authorised: sourcingEligible && feeConfigured,
    sourcing_activation_authorised: false,
    human_review_required: outcome === 'HUMAN_REVIEW_REQUIRED',
    hold_for_information: outcome === 'HOLD_FOR_INFORMATION',
    conditions,
    blockers: [...verifiedBlockers, ...verifiedFindingBlockers],
    missing_information: missing,
    permit_disclosure: permitDisclosure,
    payment: {
      fee_configured: feeConfigured,
      amount: feeConfigured ? laneFee : null,
      currency,
      fee_band: urgency.band,
      payment_authorisation: sourcingEligible && feeConfigured,
      payment_provider_url: env.SUB72_PAYMENT_URL || null,
      note: feeConfigured
        ? 'Payment covers the preliminary sourcing activation service only; it does not guarantee aircraft availability, operator acceptance, permits or flight execution.'
        : 'The preliminary assessment is complete, but the Sub-72 fee amount is not configured on the Worker.',
    },
    decision_basis: {
      ruleset: '15D-SUB72-DETERMINISTIC-1.0',
      research_model_is_decision_authority: false,
      evidence_count: findings.length,
      citation_count: evidence?.citations?.length || 0,
      airfield_resolution_complete: Boolean(airfield?.airport_resolution_complete),
    },
    evaluated_at: new Date().toISOString(),
  };
}

function parseOptionalAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : null;
}
function isAuthoritativeUrl(value, allowlist) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return allowlist.some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}

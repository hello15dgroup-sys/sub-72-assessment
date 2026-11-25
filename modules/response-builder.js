export function buildPublicResponse({ mission, urgency, assessmentRunId, decision, intelligence, assessmentVersion }) {
  const eligible = decision.sourcing_eligible;
  const nextAction = !eligible
    ? decision.outcome === 'HOLD_FOR_INFORMATION' ? 'PROVIDE_REQUIRED_INFORMATION'
      : decision.outcome === 'HUMAN_REVIEW_REQUIRED' ? 'WAIT_FOR_15D_REVIEW'
        : 'MISSION_CANNOT_PROCEED'
    : decision.fee_collection_authorised ? 'PROCEED_TO_PAYMENT' : 'PAYMENT_CONFIGURATION_REQUIRED';

  return {
    ok: true,
    schema_version: '15D-SUB72-RESPONSE-1.0',
    service: 'SUB_72_HOUR_MISSION_ASSESSMENT',
    mission_id: mission.missionId,
    assessment_run_id: assessmentRunId,
    assessment_status: decision.outcome === 'HUMAN_REVIEW_REQUIRED' ? 'HUMAN_REVIEW_REQUIRED' : 'COMPLETED',
    urgency: {
      band: urgency.band,
      hours_to_departure: urgency.hoursToDeparture,
      departure_at: mission.departureAt.toISOString(),
    },
    decision: {
      outcome: decision.outcome,
      sourcing_eligible: decision.sourcing_eligible,
      fee_collection_authorised: decision.fee_collection_authorised,
      sourcing_activation_authorised: decision.sourcing_activation_authorised,
      human_review_required: decision.human_review_required,
      rationale: decision.rationale,
      conditions: decision.conditions,
      blockers: decision.blockers,
      missing_information: decision.missing_information,
    },
    preliminary_summary: intelligence.model_output.summary,
    evidence: {
      count: intelligence.evidence.findings.length,
      citations: intelligence.evidence.citations,
      limitations: 'This is a preliminary sourcing assessment, not an aircraft reservation, permit approval, operator acceptance or flight release.',
    },
    permit_disclosure: decision.permit_disclosure,
    payment: decision.payment,
    next_action: nextAction,
    assessment_version: assessmentVersion,
    created_at: new Date().toISOString(),
  };
}

import { calculateUrgency } from './urgency-engine.js';
import { assessMission } from './regulator.js';

const now = new Date('2026-11-25T12:00:00Z');
const laneA = calculateUrgency('2026-11-27T00:00:00Z', now);
if (laneA.band !== 'LANE_A') throw new Error('Lane A test failed');
const laneB = calculateUrgency('2026-11-25T18:00:00Z', now);
if (laneB.band !== 'LANE_B') throw new Error('Lane B test failed');
let rejected = false;
try { calculateUrgency('2026-11-28T12:00:00Z', now); } catch (e) { rejected = e.code === 'NOT_A_SUB72_MISSION'; }
if (!rejected) throw new Error('72-hour boundary test failed');

const base = {
  mission: {}, urgency: { band: 'LANE_A' },
  airfield: { airport_resolution_complete: true, route_classification: 'INTERNATIONAL', cross_border_indicator: true },
  intelligence: {
    schema_valid: true,
    findings: [{ status: 'VERIFIED', severity: 'INFORMATIONAL', authority_level: 'OFFICIAL_AIP', source_urls: ['https://aip.example.gov/page'], statement: 'Published airport information.' }],
    candidate_blockers: [], missing_information: [], conflicting_information: [], potential_conditions: [],
  },
  evidence: { structured_output_valid: true, citations: [{ url: 'https://aip.example.gov/page' }] },
  env: { AUTHORITATIVE_SOURCE_DOMAINS: 'example.gov', SUB72_LANE_A_FEE_AMOUNT: '250' },
};
const go = assessMission(base);
if (go.outcome !== 'SOURCING_GO' || !go.fee_collection_authorised || go.sourcing_activation_authorised) {
  throw new Error('GO / payment separation test failed');
}
const unresolved = assessMission({ ...base, intelligence: { ...base.intelligence, candidate_blockers: [{ type: 'CONFIRMED_LEGAL_PROHIBITION', status: 'UNVERIFIED', authority_level: 'UNKNOWN', source_urls: [] }] } });
if (unresolved.outcome !== 'HUMAN_REVIEW_REQUIRED') throw new Error('Unverified blocker escalation test failed');
console.log('Sub-72 smoke tests passed.');

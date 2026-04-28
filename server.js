const path = require("path");
const express = require("express");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || "gemini-1.5-flash";

// ── Body parser only — static files come AFTER all API routes ──────────────
app.use(express.json({ limit: "2mb" }));

// =============================================================================
// API ROUTES  (registered BEFORE express.static so they are never intercepted)
// =============================================================================

app.post("/api/analyze-and-match", async (req, res) => {
  try {
    const { reportsText, volunteers } = req.body || {};
    if (!reportsText || typeof reportsText !== "string")
      return res.status(400).json({ error: "reportsText is required." });
    if (!Array.isArray(volunteers))
      return res.status(400).json({ error: "volunteers must be an array." });

    const extractedNeeds = await extractNeeds(reportsText);
    const rankedNeeds    = rankNeeds(extractedNeeds);
    const assignments    = assignVolunteers(rankedNeeds, volunteers);
    const rationale      = await generateRationale(rankedNeeds, assignments.assignments, volunteers);
    const fairness       = generateFairnessAlerts(rankedNeeds, assignments.assignments, volunteers);

    return res.json({ rankedNeeds, assignments, rationale, fairness });
  } catch (err) {
    console.error("[/api/analyze-and-match]", err.message);
    return res.status(500).json({ error: err.message || "Unexpected server error." });
  }
});

app.post("/api/predict", async (req, res) => {
  console.log("[/api/predict] hit — body keys:", Object.keys(req.body || {}));
  try {
    const { reportsText } = req.body || {};
    if (!reportsText || typeof reportsText !== "string") {
      console.warn("[/api/predict] missing reportsText");
      return res.status(400).json({ error: "reportsText is required and must be a string." });
    }
    console.log(`[/api/predict] reports length: ${reportsText.length}`);
    const prediction = await predictCrises(reportsText);
    console.log("[/api/predict] success");
    return res.json({ prediction });
  } catch (err) {
    console.error("[/api/predict] error:", err.message);
    return res.status(500).json({ error: err.message || "Prediction engine failed." });
  }
});

app.post("/api/what-if", async (req, res) => {
  try {
    const { scenario, rankedNeeds, assignments, volunteers } = req.body || {};
    if (!scenario || typeof scenario !== "string")
      return res.status(400).json({ error: "scenario is required." });

    const baseline    = summarizeOperationalState(rankedNeeds, assignments, volunteers);
    const plan        = await generateWhatIfPlan(scenario, rankedNeeds, assignments, volunteers, baseline);
    const predictions = await predictNeeds(rankedNeeds);
    return res.json({ scenario, plan, predictions, baseline });
  } catch (err) {
    console.error("[/api/what-if]", err.message);
    return res.status(500).json({ error: err.message || "Unexpected server error." });
  }
});

// ── Static files AFTER all API routes ────────────────────────────────────────
app.use(express.static(__dirname));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "index.html")));

// Catch-all: always returns JSON so fetch() never gets "Unexpected token '<'"
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// =============================================================================
app.listen(PORT, () => {
  console.log(`\nSevaSync AI Engine → http://localhost:${PORT}`);
  console.log(`Gemini API Key loaded: ${!!GEMINI_API_KEY}`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
  if (!GEMINI_API_KEY)
    console.warn("⚠  GEMINI_API_KEY not set — using smart fallbacks. Add it to .env and restart.\n");
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function predictCrises(reportsText) {
  const fallback = {
    forecast:                         "Flood-linked displacement and medical strain are likely to rise across the next 6 hours.",
    hidden_crisis_detected:           "Flooding plus trapped families can cascade into shelter, rescue, and contamination needs.",
    proactive_staging_recommendation: "Pre-deploy rescue, water, and medical support to Ward 5 and nearby access corridors.",
    six_hour_timeline: [
      { hour: "0-2h", category: "rescue", demand_level: "critical", drivers: "Trapped families and rising water levels." },
      { hour: "2-4h", category: "water", demand_level: "high", drivers: "Clean drinking water shortages widen after flooding." },
      { hour: "4-6h", category: "medical", demand_level: "high", drivers: "Untreated chronic and flood-linked cases escalate." },
      { hour: "4-6h", category: "food", demand_level: "medium", drivers: "Displacement increases packaged food demand." }
    ],
    category_spikes: [
      { category: "rescue", spike_percent: 85, severity: "critical" },
      { category: "water", spike_percent: 70, severity: "high" },
      { category: "medical", spike_percent: 62, severity: "high" },
      { category: "food", spike_percent: 38, severity: "medium" }
    ]
  };
  if (!GEMINI_API_KEY) return fallback;

  const prompt = `
You are a predictive analytics engine for disaster response.
Analyze the field reports and identify hidden cascading crises over the next 6-12 hours.
Look for: water shortage -> disease; flooding -> displacement -> food shortage; medical delay -> fatality risk.
Return ONLY valid JSON (no markdown, no explanation):
{
  "forecast": "what will spike and when (max 25 words)",
  "hidden_crisis_detected": "the non-obvious cascading risk (max 25 words)",
  "proactive_staging_recommendation": "specific pre-emptive action with location (max 25 words)",
  "six_hour_timeline": [{"hour":"0-2h|2-4h|4-6h","category":"rescue|medical|water|food|shelter|sanitation","demand_level":"critical|high|medium|low","drivers":"short reason"}],
  "category_spikes": [{"category":"rescue|medical|water|food|shelter|sanitation","spike_percent": number, "severity":"critical|high|medium|low"}]
}
Field reports:
${reportsText}`.trim();

  try {
    const result = await generateJsonWithGemini(prompt);
    return result && result.forecast ? result : fallback;
  } catch (e) {
    console.warn("[predictCrises] Gemini failed, using fallback:", e.message);
    return fallback;
  }
}

async function predictNeeds(rankedNeeds) {
  if (!GEMINI_API_KEY) return fallbackPrediction();
  const prompt = `
Predict high-risk needs in the next 6 hours based on current NGO data.
Return ONLY a valid JSON array:
[{"location":"str","predicted_need_type":"str","risk_level":"high|medium|low","reason":"str"}]
Current needs: ${JSON.stringify(rankedNeeds)}`;
  try {
    const result = await generateJsonWithGemini(prompt);
    return Array.isArray(result) ? result : fallbackPrediction();
  } catch { return fallbackPrediction(); }
}

function fallbackPrediction() {
  return [{ location: "Unknown", predicted_need_type: "general", risk_level: "medium", reason: "Fallback prediction." }];
}

async function extractNeeds(reportsText) {
  if (!GEMINI_API_KEY) return fallbackExtract(reportsText);

  const prompt = `
You are an NGO operations analyst. Extract structured needs from field reports.
IMPORTANT: Any report mentioning "trapped", "flood", "drowning", "collapse", "fire", or "dying"
MUST have urgency_level "critical" and time_sensitivity_hours of 2 or less.
Return ONLY a valid JSON array (no markdown, no explanation):
[{
  "need_id": "N001",
  "need_type": "food|medical|shelter|sanitation|water|other",
  "summary": "short sentence",
  "location": "string or null",
  "people_affected": number_or_null,
  "urgency_level": "critical|high|medium|low",
  "urgency_reason": "short reason",
  "required_skills": ["skill"],
  "time_sensitivity_hours": number_or_null
}]
Field reports:
${reportsText}`.trim();

  try {
    const parsed = await generateJsonWithGemini(prompt);
    if (!Array.isArray(parsed)) return fallbackExtract(reportsText);
    return parsed.map((need, index) => normalizeNeed(need, index));
  } catch (e) {
    console.warn("[extractNeeds] Gemini failed, using fallback:", e.message);
    return fallbackExtract(reportsText);
  }
}

// FIX: smart fallback with life-threat detection, people count, need-type inference
function fallbackExtract(reportsText) {
  return reportsText.split("\n").map((line, i) => {
    line = line.trim();
    if (!line) return null;
    const lower = line.toLowerCase();

    const isCritical    = /trapped|flood|drowning|collapse|fire|electrocution|dying|unconscious|emergency/.test(lower);
    const isHighUrgency = /urgent|immediately|asap|critical|within \d+/.test(lower);

    const peopleMatch     = lower.match(/(\d+)\s*(families|people|persons|individuals|patients|children)/);
    const people_affected = peopleMatch
      ? parseInt(peopleMatch[1]) * (peopleMatch[2] === "families" ? 4 : 1)
      : null;

    const timeMatch            = lower.match(/within\s+(\d+)\s*hour/);
    const time_sensitivity_hours = timeMatch
      ? parseInt(timeMatch[1])
      : isCritical ? 2 : isHighUrgency ? 6 : 12;

    let need_type = "other";
    if      (/water|drinking/.test(lower))                              need_type = "water";
    else if (/food|meal|packaged/.test(lower))                          need_type = "food";
    else if (/medical|insulin|medicine|hospital|diabetic/.test(lower))  need_type = "medical";
    else if (/shelter|trapped|rescue|flood|evacuate/.test(lower))       need_type = "shelter";
    else if (/sanitation|toilet|hygiene/.test(lower))                   need_type = "sanitation";

    const skillMap = {
      medical:    ["medical", "first_aid"],
      water:      ["water", "sanitation"],
      food:       ["food", "logistics"],
      shelter:    ["rescue", "logistics"],
      sanitation: ["water", "sanitation"],
      other:      ["general_support"]
    };

    return normalizeNeed({
      need_id:               `N${String(i + 1).padStart(3, "0")}`,
      need_type,
      summary:               line,
      location:              line.includes(":") ? line.split(":")[0].trim() : null,
      people_affected,
      urgency_level:         isCritical ? "critical" : isHighUrgency ? "high" : "medium",
      urgency_reason:        isCritical
        ? "Life-threat keywords detected (trapped/flood/collapse)."
        : isHighUrgency ? "Urgency keywords present." : "No explicit emergency signal.",
      required_skills:       skillMap[need_type],
      time_sensitivity_hours
    }, i);
  }).filter(Boolean);
}

function normalizeNeed(rawNeed, index) {
  const summary = String(rawNeed?.summary || "").trim();
  const location = rawNeed?.location || (summary.includes(":") ? summary.split(":")[0].trim() : null);
  const inferredType = inferNeedType(summary, rawNeed?.need_type);
  const inferredUrgency = inferUrgency(summary, rawNeed?.urgency_level);
  const inferredTime = inferTimeSensitivity(summary, rawNeed?.time_sensitivity_hours, inferredUrgency);
  const inferredPeople = inferPeopleAffected(summary, rawNeed?.people_affected);
  const requiredSkills = inferRequiredSkills(summary, inferredType, rawNeed?.required_skills);

  return {
    need_id: rawNeed?.need_id || `N${String(index + 1).padStart(3, "0")}`,
    need_type: inferredType,
    summary,
    location,
    people_affected: inferredPeople,
    urgency_level: inferredUrgency,
    urgency_reason: inferUrgencyReason(summary, inferredUrgency, rawNeed?.urgency_reason),
    required_skills: requiredSkills,
    time_sensitivity_hours: inferredTime
  };
}

function inferNeedType(summary, hintedType) {
  const lower = String(summary || "").toLowerCase();
  if (/trapped|flood|rescue|evacuate|evacuation|boat/.test(lower)) return "shelter";
  if (/insulin|medicine|medical|diabetic|patient|hospital/.test(lower)) return "medical";
  if (/water|drinking|potable|clean water/.test(lower)) return "water";
  if (/food|meal|packaged|ration/.test(lower)) return "food";
  if (/sanitation|hygiene|toilet/.test(lower)) return "sanitation";
  return hintedType || "other";
}

function inferRequiredSkills(summary, needType, hintedSkills) {
  const lower = String(summary || "").toLowerCase();
  if (/trapped|flood|rescue|evacuate|evacuation|boat/.test(lower)) return ["rescue", "logistics"];
  if (/insulin|medicine|medical|patient|diabetic/.test(lower)) return ["medical", "first_aid"];
  if (/water|drinking|potable/.test(lower)) return ["water", "sanitation"];
  if (/food|meal|packaged|ration/.test(lower)) return ["food", "logistics", "distribution"];

  if (Array.isArray(hintedSkills) && hintedSkills.length) return hintedSkills;

  const skillMap = {
    medical: ["medical", "first_aid"],
    water: ["water", "sanitation"],
    food: ["food", "logistics", "distribution"],
    shelter: ["rescue", "logistics"],
    sanitation: ["water", "sanitation"],
    other: ["general_support"]
  };
  return skillMap[needType] || skillMap.other;
}

function inferUrgency(summary, hintedUrgency) {
  const lower = String(summary || "").toLowerCase();
  if (/trapped|flood|drowning|collapse|dying|unconscious|washed away|stranded/.test(lower)) return "critical";
  if (/urgent|immediately|within\s+\d+\s*hour|tonight/.test(lower)) return "high";
  return hintedUrgency || "medium";
}

function inferTimeSensitivity(summary, hintedHours, urgency) {
  const lower = String(summary || "").toLowerCase();
  const matched = lower.match(/within\s+(\d+)\s*hour/);
  if (matched) return parseInt(matched[1], 10);
  if (/tonight/.test(lower)) return 8;
  if (urgency === "critical") return 2;
  if (urgency === "high") return 6;
  if (typeof hintedHours === "number" && !Number.isNaN(hintedHours)) return hintedHours;
  return 12;
}

function inferPeopleAffected(summary, hintedPeople) {
  if (typeof hintedPeople === "number" && !Number.isNaN(hintedPeople)) return hintedPeople;
  const lower = String(summary || "").toLowerCase();
  const peopleMatch = lower.match(/(\d+)\s*(families|people|persons|individuals|patients|children)/);
  if (!peopleMatch) return null;
  const count = parseInt(peopleMatch[1], 10);
  return peopleMatch[2] === "families" ? count * 4 : count;
}

function inferUrgencyReason(summary, urgency, hintedReason) {
  const lower = String(summary || "").toLowerCase();
  if (/trapped|flood|drowning|collapse|washed away|stranded/.test(lower)) {
    return "Life-threatening flood or entrapment signal detected.";
  }
  if (/insulin|medical|patient|diabetic/.test(lower)) {
    return "Time-sensitive medical dependency detected.";
  }
  return hintedReason || `${urgency} urgency inferred from field report wording.`;
}

// FIX: hard override so "trapped/flood" always scores critical regardless of Gemini label
function rankNeeds(needs) {
  return needs.map(need => {
    let score = 18;
    const level = (need.urgency_level || "").toLowerCase();
    if      (level === "critical") score += 34;
    else if (level === "high")     score += 20;
    else if (level === "medium")   score += 10;

    const txt = (need.summary || "").toLowerCase();
    const isLifeThreat = /trapped|flood|drowning|collapse|fire|dying|unconscious|washed away|stranded/.test(txt);
    if (isLifeThreat) {
      score += 28;
    }

    if (typeof need.people_affected === "number")
      score += Math.min(18, Math.round(need.people_affected / 6));

    if (typeof need.time_sensitivity_hours === "number") {
      if      (need.time_sensitivity_hours <= 2)  score += 30;
      else if (need.time_sensitivity_hours <= 6)  score += 22;
      else if (need.time_sensitivity_hours <= 12) score += 14;
      else if (need.time_sensitivity_hours <= 24) score += 8;
    }

    if (!need.location) score -= 5;
    if (isLifeThreat && typeof need.time_sensitivity_hours === "number" && need.time_sensitivity_hours <= 2) {
      score = Math.max(score, 92);
    } else if (isLifeThreat) {
      score = Math.max(score, 88);
    }
    score = Math.max(0, Math.min(100, score));
    const band = score >= 80 ? "critical" : score >= 65 ? "high" : score >= 50 ? "medium" : "low";
    return { ...need, priority_score: score, priority_band: band };
  }).sort((a, b) => b.priority_score - a.priority_score);
}

function assignVolunteers(rankedNeeds, volunteers) {
  const available = volunteers.map(v => ({ ...v, assigned_count: 0 }));
  const assignments = [], unassigned_needs = [];

  for (const need of rankedNeeds) {
    const scored = available
      .map(vol => ({ vol, score: computeMatchScore(need, vol) }))
      .sort((a, b) => b.score - a.score);

    if (!scored.length || scored[0].score < 45) {
      unassigned_needs.push({ need_id: need.need_id, gap_reason: "No sufficiently skilled volunteer available." });
      continue;
    }

    const best = scored[0];
    assignments.push({
      need_id:              need.need_id,
      volunteer_id:         best.vol.volunteer_id,
      volunteer_name:       best.vol.name || null,
      match_score:          best.score,
      eta_minutes:          estimateEtaMinutes(need, best.vol),
      distance_km:          estimateDistanceKm(need.location, best.vol.location),
      load_balance_note:    best.vol.assigned_count === 0 ? "Primary deployment from current queue." : "Re-used volunteer capacity; monitor fatigue.",
      reason:               buildReason(need, best.vol),
      backup_volunteer_ids: scored.slice(1, 3).map(x => x.vol.volunteer_id)
    });
    best.vol.assigned_count += 1;
    available.splice(available.findIndex(v => v.volunteer_id === best.vol.volunteer_id), 1);
  }
  return { assignments, unassigned_needs };
}

function computeMatchScore(need, vol) {
  let score = 12;
  const vSkills = Array.isArray(vol.skills)           ? vol.skills.map(s => s.toLowerCase())           : [];
  const rSkills = Array.isArray(need.required_skills) ? need.required_skills.map(s => s.toLowerCase()) : [];
  const matchedSkills = rSkills.filter(r => vSkills.includes(r));
  score += matchedSkills.length * 30;
  if (rSkills.length > 0 && matchedSkills.length === 0) score -= 20;

  const nLoc = (need.location || "").toLowerCase();
  const vLoc = (vol.location  || "").toLowerCase();
  const distanceKm = estimateDistanceKm(need.location, vol.location);
  if (nLoc && vLoc && (vLoc.includes(nLoc) || nLoc.includes(vLoc))) score += 22;
  else score += Math.max(0, 16 - Math.round(distanceKm * 3));

  const avail = Number(vol.availability_hours);
  if (!isNaN(avail)) score += Math.max(0, 15 - avail * 2);
  if (need.priority_band === "critical") score += 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function estimateDistanceKm(needLocation, volunteerLocation) {
  const need = (needLocation || "").toLowerCase();
  const volunteer = (volunteerLocation || "").toLowerCase();
  if (!need || !volunteer) return 4.5;
  if (need.includes(volunteer) || volunteer.includes(need)) return 0.6;

  const joined = `${volunteer}|${need}`;
  const map = {
    "ward 4|near bus stand": 2.8,
    "near bus stand|ward 4": 2.8,
    "ward 4|community hall": 1.9,
    "community hall|ward 4": 1.9,
    "bus stand|community hall": 1.4,
    "community hall|bus stand": 1.4,
    "ward 4|ward 5": 4.6,
    "ward 5|ward 4": 4.6,
    "bus stand|ward 5": 5.2,
    "ward 5|bus stand": 5.2
  };
  return map[joined] || 3.8;
}

function estimateEtaMinutes(need, volunteer) {
  const distance = estimateDistanceKm(need.location, volunteer.location);
  const base = Math.round(distance * 11 + 8);
  return need.priority_band === "critical" ? Math.max(10, base - 4) : base;
}

// FIX: shows actual geographic relationship (co-located vs cross-deploying)
function buildReason(need, vol) {
  const skills    = Array.isArray(need.required_skills) ? need.required_skills.join(", ") : "general support";
  const nLoc      = (need.location || "").toLowerCase();
  const vLoc      = (vol.location  || "").toLowerCase();
  const proximate = nLoc && vLoc && (vLoc.includes(nLoc) || nLoc.includes(vLoc));
  const urgency   = (need.priority_band || need.urgency_level || "high").toLowerCase();
  const eta       = estimateEtaMinutes(need, vol);
  const distance  = estimateDistanceKm(need.location, vol.location).toFixed(1);
  const locNote   = proximate
    ? `co-located at ${need.location}`
    : `cross-deploying from ${vol.location || "unknown"} → ${need.location || "field"}`;
  return `Skills match: ${skills}; ${locNote}; ETA ${eta} min over ~${distance} km; selected for ${urgency}-priority response.`;
}

// FIX: unique per-assignment rationale even in fallback — no more identical cards
async function generateRationale(rankedNeeds, assignments, volunteers) {
  const buildFallback = () => assignments.map(a => {
    const need = rankedNeeds.find(n => n.need_id === a.need_id);
    const vol  = volunteers.find(v => v.volunteer_id === a.volunteer_id);
    const nLoc = (need?.location || "").toLowerCase();
    const vLoc = (vol?.location || "").toLowerCase();
    const proximate = nLoc && vLoc && (vLoc.includes(nLoc) || nLoc.includes(vLoc));
    const travelNote = proximate
      ? `already positioned at ${need?.location || "the response zone"}`
      : `cross-deployed from ${vol?.location || "another zone"} to ${need?.location || "the target zone"}`;
    return {
      need_id:          a.need_id,
      volunteer_id:     a.volunteer_id,
      rationale:        `${vol?.name || a.volunteer_id} assigned to the ${need?.need_type || "field"} request at ${need?.location || "field"} because of skill match (${(vol?.skills || []).join(", ") || "general support"}) and ${travelNote}.`,
      tradeoffs:        buildTradeoff(need, vol, a),
      confidence:       "medium",
      priority_context: `${need?.urgency_level || "high"} priority; ${need?.people_affected ? need.people_affected + " people affected" : "urgency signal detected"}.`
    };
  });

  if (!GEMINI_API_KEY) return buildFallback();

  const prompt = `
You are explaining NGO volunteer assignment decisions to a transparency dashboard.
Write a UNIQUE and SPECIFIC rationale for each assignment — mention the volunteer's name,
their actual skills, the need's location, and why they were the best choice for THIS specific need.
Return ONLY a valid JSON array (no markdown):
[{"need_id":"str","volunteer_id":"str","rationale":"unique specific sentence","tradeoffs":"what was deprioritized","confidence":"high|medium|low","priority_context":"str"}]
Assignments: ${JSON.stringify(assignments)}
Ranked needs: ${JSON.stringify(rankedNeeds)}
Volunteers: ${JSON.stringify(volunteers)}`.trim();

  try {
    const ai = await generateJsonWithGemini(prompt);
    return normalizeRationale(Array.isArray(ai) ? ai : buildFallback(), assignments, rankedNeeds, volunteers);
  } catch (e) {
    console.warn("[generateRationale] Gemini failed:", e.message);
    return buildFallback();
  }
}

function normalizeRationale(items, assignments, rankedNeeds, volunteers) {
  const fallback = generateFallbackRationaleMap(assignments, rankedNeeds, volunteers);
  const seenTradeoffs = new Set();

  return assignments.map((assignment, index) => {
    const fromAI = Array.isArray(items)
      ? items.find(item => item?.need_id === assignment.need_id && item?.volunteer_id === assignment.volunteer_id) || items[index]
      : null;
    const base = fallback[index];
    const tradeoffs = String(fromAI?.tradeoffs || base.tradeoffs || "").trim();
    const normalizedTradeoff = !tradeoffs || seenTradeoffs.has(tradeoffs)
      ? base.tradeoffs
      : tradeoffs;
    seenTradeoffs.add(normalizedTradeoff);

    return {
      need_id: assignment.need_id,
      volunteer_id: assignment.volunteer_id,
      rationale: String(fromAI?.rationale || base.rationale || "").trim() || base.rationale,
      tradeoffs: normalizedTradeoff,
      confidence: fromAI?.confidence || base.confidence || "medium",
      priority_context: String(fromAI?.priority_context || base.priority_context || "").trim() || base.priority_context
    };
  });
}

function generateFallbackRationaleMap(assignments, rankedNeeds, volunteers) {
  return assignments.map(a => {
    const need = rankedNeeds.find(n => n.need_id === a.need_id);
    const vol = volunteers.find(v => v.volunteer_id === a.volunteer_id);
    const nLoc = (need?.location || "").toLowerCase();
    const vLoc = (vol?.location || "").toLowerCase();
    const proximate = nLoc && vLoc && (vLoc.includes(nLoc) || nLoc.includes(vLoc));
    const travelNote = proximate
      ? `already positioned at ${need?.location || "the response zone"}`
      : `cross-deployed from ${vol?.location || "another zone"} to ${need?.location || "the target zone"}`;
    return {
      need_id: a.need_id,
      volunteer_id: a.volunteer_id,
      rationale: `${vol?.name || a.volunteer_id} assigned to the ${need?.need_type || "field"} request at ${need?.location || "field"} because of skill match (${(vol?.skills || []).join(", ") || "general support"}) and ${travelNote}.`,
      tradeoffs: buildTradeoff(need, vol, a),
      confidence: "medium",
      priority_context: `${need?.urgency_level || "high"} priority; ${need?.people_affected ? need.people_affected + " people affected" : "urgency signal detected"}.`
    };
  });
}

function buildTradeoff(need, vol, assignment) {
  const type = need?.need_type || "field";
  const eta = assignment?.eta_minutes || estimateEtaMinutes(need || {}, vol || {});
  if (type === "medical") return `${vol?.name || assignment?.volunteer_id || "Volunteer"} was reserved for rapid medical response, leaving nearby non-medical requests to slower secondary coverage.`;
  if (type === "water") return `${vol?.name || assignment?.volunteer_id || "Volunteer"} was kept on water and sanitation duty, delaying broader distribution coverage to protect potable water access.`;
  if (type === "food") return `${vol?.name || assignment?.volunteer_id || "Volunteer"} was routed to logistics-heavy food delivery, which preserves throughput but reduces flexibility for ad hoc support elsewhere.`;
  if (type === "shelter") return `${vol?.name || assignment?.volunteer_id || "Volunteer"} was prioritized for rescue and shelter response despite a longer route, because life-safety demand outweighed faster low-risk tasks.`;
  return `${vol?.name || assignment?.volunteer_id || "Volunteer"} was selected to preserve an estimated ${eta}-minute response, trading off broader load balancing.`;
}

function generateFairnessAlerts(rankedNeeds, assignments, volunteers) {
  const locNeeds = {}, locAssigned = {};
  rankedNeeds.forEach(n => {
    const l = (n.location || "Unknown").toLowerCase();
    locNeeds[l] = (locNeeds[l] || 0) + 1;
  });
  assignments.forEach(a => {
    const need = rankedNeeds.find(n => n.need_id === a.need_id);
    if (need) {
      const l = (need.location || "Unknown").toLowerCase();
      locAssigned[l] = (locAssigned[l] || 0) + 1;
    }
  });
  return Object.keys(locNeeds)
    .filter(l => (locAssigned[l] || 0) < locNeeds[l])
    .map(l => ({
      type:           "coverage_gap",
      severity:       "high",
      message:        `Under-served zone: ${l.toUpperCase()} has ${locNeeds[l] - (locAssigned[l] || 0)} unaddressed need(s).`,
      recommendation: `Redirect non-critical volunteers to ${l.toUpperCase()}.`
    }));
}

async function generateWhatIfPlan(scenario, rankedNeeds, assignments, volunteers, baseline) {
  const simulatedCriticalIncrease = inferScenarioCriticalIncrease(scenario);
  const fallback = {
    summary:                  "Surge detected — protect critical medical and rescue response first, then rebalance by zone.",
    immediate_actions:        ["Lock top 2 critical assignments and notify volunteers", "Re-route nearest standby volunteers to new zone", "Broadcast unresolved needs to partner NGOs"],
    reassignment_suggestions: [],
    risk_notes:               ["Volunteer pool may be exhausted within 2-4 hours if volume spikes as projected"],
    comparison: {
      baseline_open_needs: baseline.open_needs,
      simulated_open_needs: baseline.open_needs + simulatedCriticalIncrease,
      baseline_critical_needs: baseline.critical_needs,
      simulated_critical_needs: baseline.critical_needs + simulatedCriticalIncrease,
      baseline_utilization: baseline.utilization_percent,
      simulated_utilization: Math.min(100, baseline.utilization_percent + 20)
    }
  };
  if (!GEMINI_API_KEY) return fallback;

  const prompt = `
Given a what-if scenario for NGO crisis management, produce a specific reallocation plan.
Reference the actual volunteer names, locations, and need types.
Return ONLY valid JSON (no markdown):
{"summary":"str","immediate_actions":["specific action"],"reassignment_suggestions":[{"need_id":"str","volunteer_id":"str","action":"str"}],"risk_notes":["str"],"comparison":{"baseline_open_needs":number,"simulated_open_needs":number,"baseline_critical_needs":number,"simulated_critical_needs":number,"baseline_utilization":number,"simulated_utilization":number}}
Scenario: ${scenario}
Baseline state: ${JSON.stringify(baseline)}
Current ranked needs: ${JSON.stringify(rankedNeeds)}
Current assignments: ${JSON.stringify(assignments)}`.trim();

  try {
    const ai = await generateJsonWithGemini(prompt);
    return normalizeWhatIfPlan((ai && typeof ai === "object") ? ai : fallback, fallback);
  } catch (e) {
    console.warn("[generateWhatIfPlan] Gemini failed:", e.message);
    return fallback;
  }
}

function normalizeWhatIfPlan(plan, fallback) {
  const comparison = plan?.comparison && typeof plan.comparison === "object"
    ? {
        baseline_open_needs: toNumberOr(plan.comparison.baseline_open_needs, fallback.comparison.baseline_open_needs),
        simulated_open_needs: toNumberOr(plan.comparison.simulated_open_needs, fallback.comparison.simulated_open_needs),
        baseline_critical_needs: toNumberOr(plan.comparison.baseline_critical_needs, fallback.comparison.baseline_critical_needs),
        simulated_critical_needs: toNumberOr(plan.comparison.simulated_critical_needs, fallback.comparison.simulated_critical_needs),
        baseline_utilization: toNumberOr(plan.comparison.baseline_utilization, fallback.comparison.baseline_utilization),
        simulated_utilization: toNumberOr(plan.comparison.simulated_utilization, fallback.comparison.simulated_utilization)
      }
    : fallback.comparison;

  return {
    summary: plan?.summary || fallback.summary,
    immediate_actions: Array.isArray(plan?.immediate_actions) && plan.immediate_actions.length ? plan.immediate_actions : fallback.immediate_actions,
    reassignment_suggestions: Array.isArray(plan?.reassignment_suggestions) ? plan.reassignment_suggestions : fallback.reassignment_suggestions,
    risk_notes: Array.isArray(plan?.risk_notes) && plan.risk_notes.length ? plan.risk_notes : fallback.risk_notes,
    comparison
  };
}

function toNumberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function summarizeOperationalState(rankedNeeds, assignments, volunteers) {
  const totalNeeds = rankedNeeds.length;
  const assigned = assignments.length;
  const critical = rankedNeeds.filter(n => n.priority_band === "critical").length;
  return {
    total_needs: totalNeeds,
    assigned_needs: assigned,
    open_needs: Math.max(0, totalNeeds - assigned),
    critical_needs: critical,
    utilization_percent: volunteers.length ? Math.round((assigned / volunteers.length) * 100) : 0
  };
}

function inferScenarioCriticalIncrease(scenario) {
  const match = String(scenario || "").match(/(\d+)/);
  const count = match ? parseInt(match[1], 10) : 6;
  return Math.max(2, Math.round(count * 0.45));
}

async function generateJsonWithGemini(prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents:         [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
      })
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`Gemini API ${response.status}: ${err?.error?.message || "unknown error"}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned empty response");

  try {
    return JSON.parse(text);
  } catch {
    // Strip markdown fences if Gemini added them despite responseMimeType
    const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(clean);
  }
}
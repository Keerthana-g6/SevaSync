const reportsInput = document.getElementById("reportsInput");
const volunteersInput = document.getElementById("volunteersInput");
const runBtn = document.getElementById("runBtn");
const loadSampleBtn = document.getElementById("loadSampleBtn");
const simulateBtn = document.getElementById("simulateBtn");
const predictBtn = document.getElementById("predictBtn");
const statusEl = document.getElementById("status");
const needsOutput = document.getElementById("needsOutput");
const assignmentsOutput = document.getElementById("assignmentsOutput");
const rationaleOutput = document.getElementById("rationaleOutput");
const fairnessOutput = document.getElementById("fairnessOutput");
const scenarioInput = document.getElementById("scenarioInput");
const whatIfOutput = document.getElementById("whatIfOutput");
const metricsOutput = document.getElementById("metricsOutput");
const predictionOutput = document.getElementById("predictionOutput");

let lastResult = null;

const sampleVolunteers = [
  { volunteer_id: "V001", name: "Asha", skills: ["medical", "first_aid"], location: "Ward 4", availability_hours: 8 },
  { volunteer_id: "V002", name: "Ravi", skills: ["food", "logistics", "distribution"], location: "Bus Stand", availability_hours: 6 },
  { volunteer_id: "V003", name: "Neha", skills: ["water", "sanitation"], location: "Ward 4", availability_hours: 4 }
];

const sampleReports = [
  "Ward 4: 17 families need clean drinking water urgently.",
  "Near bus stand: elderly diabetic patient needs insulin within 8 hours.",
  "Community hall: 30 people need packaged food by tonight.",
  "Ward 5: River water levels rising rapidly, 5 families trapped."
].join("\n");

const sampleScenario = "What if 20 additional medical and water requests are reported from Ward 6 in the next 2 hours?";

loadSampleBtn.addEventListener("click", () => {
  reportsInput.value = sampleReports;
  volunteersInput.value = JSON.stringify(sampleVolunteers, null, 2);
  scenarioInput.value = sampleScenario;
  resetOutputs();
  statusEl.textContent = "Sample crisis scenario loaded.";
});

// Dynamic Impact Metrics Calculation
function calculateImpactMetrics(needs, volunteers, assignments) {
  const totalNeeds = needs.length || 1;
  const assignedNeeds = assignments.length;
  
  // Calculate average time sensitivity based on actual AI outputs
  let totalSensitivity = 0;
  let count = 0;
  needs.forEach(n => {
    if (n.time_sensitivity_hours) {
      totalSensitivity += n.time_sensitivity_hours;
      count++;
    }
  });
  
  const avgBaseline = count > 0 ? (totalSensitivity / count) : 12; // Fallback to 12 if none found
  const reductionFactor = assignedNeeds > 0 ? (assignedNeeds / totalNeeds) * 0.85 : 0;
  const optimizedTime = Math.max(0.5, avgBaseline * (1 - reductionFactor));
  
  const volunteerUtilization = Math.round((assignedNeeds / volunteers.length) * 100) || 0;
  const criticalNeeds = needs.filter(n => n.priority_band === 'critical' || n.priority_band === 'high').length;
  
  return {
    "Response Time Reduction": `Calculated ${avgBaseline.toFixed(1)} hrs ➔ ${optimizedTime.toFixed(1)} hrs`,
    "Critical Cases Flagged": criticalNeeds,
    "Volunteer Fleet Utilization": `${volunteerUtilization}%`,
    "Coverage Ratio": `${assignedNeeds}/${needs.length} needs addressed`
  };
}

function severityClass(level) {
  const normalized = String(level || "").toLowerCase();
  if (normalized === "critical" || normalized === "high") return `severity-${normalized}`;
  if (normalized === "medium") return "severity-medium";
  return "severity-low";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMetricTile(label, value, tone = "") {
  return `<div class="metric-tile ${tone}"><span class="metric-label">${label}</span><strong class="metric-value">${value}</strong></div>`;
}

function present(value, fallback = "Not available") {
  return value === null || value === undefined || value === "" ? fallback : value;
}

function estimateScenarioLoad(scenario) {
  const match = String(scenario || "").match(/(\d+)/);
  const reported = match ? Number.parseInt(match[1], 10) : 6;
  return {
    addedRequests: reported,
    addedCritical: Math.max(2, Math.round(reported * 0.45))
  };
}

function buildSimulationComparison(plan, scenario) {
  const comparison = plan?.comparison || {};
  const baselineNeeds = Array.isArray(lastResult?.rankedNeeds) ? lastResult.rankedNeeds.length : 0;
  const baselineAssigned = Array.isArray(lastResult?.assignments?.assignments) ? lastResult.assignments.assignments.length : 0;
  const baselineCritical = Array.isArray(lastResult?.rankedNeeds)
    ? lastResult.rankedNeeds.filter(need => need.priority_band === "critical").length
    : 0;
  const baselineUtilization = Array.isArray(lastResult?.assignments?.assignments) && Array.isArray(lastResult?.volunteers)
    ? Math.round((lastResult.assignments.assignments.length / Math.max(1, lastResult.volunteers.length)) * 100)
    : null;
  const scenarioLoad = estimateScenarioLoad(scenario);

  return {
    baseline_open_needs: comparison.baseline_open_needs ?? Math.max(0, baselineNeeds - baselineAssigned),
    simulated_open_needs: comparison.simulated_open_needs ?? Math.max(0, baselineNeeds - baselineAssigned) + scenarioLoad.addedRequests,
    baseline_critical_needs: comparison.baseline_critical_needs ?? baselineCritical,
    simulated_critical_needs: comparison.simulated_critical_needs ?? baselineCritical + scenarioLoad.addedCritical,
    baseline_utilization: comparison.baseline_utilization ?? baselineUtilization ?? 0,
    simulated_utilization: comparison.simulated_utilization ?? Math.min(100, (baselineUtilization ?? 0) + 20)
  };
}

function renderResults(data, volunteersOverride) {
  needsOutput.innerHTML = data.rankedNeeds.map(n => `
    <article class="need-card ${severityClass(n.priority_band)}">
      <div class="row-between">
        <strong>${escapeHtml(n.summary)}</strong>
        <span class="pill ${severityClass(n.priority_band)}">${escapeHtml(n.priority_band).toUpperCase()}</span>
      </div>
      <div class="meta-line">📍 ${escapeHtml(n.location || "Unknown")} | Score ${escapeHtml(present(n.priority_score, 0))} | ${escapeHtml(present(n.time_sensitivity_hours, 12))}h sensitivity</div>
      <div class="meta-line">${escapeHtml(n.urgency_reason || "Urgency signal detected.")}</div>
    </article>
  `).join("");

  assignmentsOutput.innerHTML = data.assignments.assignments.map(a => `
    <article class="assignment-card">
      <div class="row-between">
        <strong>${escapeHtml(a.volunteer_name || a.volunteer_id)}</strong>
        <span class="pill severity-high">${escapeHtml(a.need_id)}</span>
      </div>
      <div class="assignment-grid">
        <div><span class="mini-label">ETA</span><strong>${escapeHtml(a.eta_minutes !== null && a.eta_minutes !== undefined ? `${a.eta_minutes} min` : "Pending route calc")}</strong></div>
        <div><span class="mini-label">Distance</span><strong>${escapeHtml(a.distance_km !== null && a.distance_km !== undefined ? `${a.distance_km} km` : "Pending map calc")}</strong></div>
        <div><span class="mini-label">Match</span><strong>${escapeHtml(present(a.match_score, 0))}</strong></div>
      </div>
      <div class="meta-line">${escapeHtml(a.reason)}</div>
      <div class="meta-line">${escapeHtml(a.load_balance_note || "")}</div>
    </article>
  `).join("");

  if (data.assignments.unassigned_needs && data.assignments.unassigned_needs.length > 0) {
    assignmentsOutput.innerHTML += `<div class="section-label">Unassigned Needs</div>`;
    assignmentsOutput.innerHTML += data.assignments.unassigned_needs.map(u =>
      `<article class="alert-card severity-high">⚠️ Need <strong>${escapeHtml(u.need_id)}</strong>: ${escapeHtml(u.gap_reason)}</article>`
    ).join("");
  }

  rationaleOutput.innerHTML = data.rationale.map(r => `
    <article class="explain-card">
      <div class="row-between">
        <strong>Decision Rationale</strong>
        <span class="pill ${severityClass(r.confidence === "high" ? "low" : "medium")}">${escapeHtml((present(r.confidence, "medium")).toUpperCase())} confidence</span>
      </div>
      <div class="meta-line">${escapeHtml(r.rationale)}</div>
      <div class="meta-line"><strong>Tradeoff:</strong> ${escapeHtml(r.tradeoffs)}</div>
      <div class="meta-line"><strong>Context:</strong> ${escapeHtml(r.priority_context || "")}</div>
    </article>
  `).join("");

  fairnessOutput.innerHTML = data.fairness.length > 0
    ? data.fairness.map(f => `
      <article class="alert-card ${severityClass(f.severity)}">
        <strong>${escapeHtml(f.severity.toUpperCase())}:</strong> ${escapeHtml(f.message)}
        <div class="meta-line">Action: ${escapeHtml(f.recommendation)}</div>
      </article>
    `).join("")
    : "<article class='alert-card severity-low'>✅ Distribution balanced across current zones.</article>";

  const metrics = calculateImpactMetrics(
    data.rankedNeeds,
    volunteersOverride || [],
    data.assignments.assignments || []
  );

  const utilizationValue = Number.parseInt(metrics["Volunteer Fleet Utilization"], 10) || 0;
  const utilizationTone = utilizationValue >= 95 ? "metric-danger" : utilizationValue >= 75 ? "metric-warn" : "metric-ok";

  metricsOutput.innerHTML = `
    <div class="metrics-grid">
      ${renderMetricTile("Response Time", metrics["Response Time Reduction"], "metric-ok")}
      ${renderMetricTile("Critical Flagged", metrics["Critical Cases Flagged"], "metric-danger")}
      ${renderMetricTile("Fleet Utilization", metrics["Volunteer Fleet Utilization"], utilizationTone)}
      ${renderMetricTile("Coverage", metrics["Coverage Ratio"], "metric-warn")}
    </div>
  `;
}

function renderPrediction(prediction) {
  const timeline = Array.isArray(prediction.six_hour_timeline) ? prediction.six_hour_timeline : [];
  const spikes = Array.isArray(prediction.category_spikes) ? prediction.category_spikes : [];
  predictionOutput.innerHTML = `
    <article class="alert-card severity-critical">
      <strong>Hidden Crisis</strong>
      <div class="meta-line">${escapeHtml(prediction.hidden_crisis_detected)}</div>
    </article>
    <article class="alert-card severity-high">
      <strong>Forecast</strong>
      <div class="meta-line">${escapeHtml(prediction.forecast)}</div>
    </article>
    <article class="alert-card severity-low">
      <strong>Proactive Step</strong>
      <div class="meta-line">${escapeHtml(prediction.proactive_staging_recommendation)}</div>
    </article>
    <div class="section-label">6-Hour Demand Timeline</div>
    <div class="timeline-list">
      ${timeline.map(item => `
        <div class="timeline-item ${severityClass(item.demand_level)}">
          <span class="timeline-hour">${escapeHtml(item.hour)}</span>
          <div>
            <strong>${escapeHtml(item.category)}</strong>
            <div class="meta-line">${escapeHtml(item.drivers)}</div>
          </div>
        </div>
      `).join("") || "<div class='meta-line'>Timeline unavailable.</div>"}
    </div>
    <div class="section-label">Projected Category Spikes</div>
    <div class="spike-list">
      ${spikes.map(item => `
        <div class="spike-row">
          <span>${escapeHtml(item.category)}</span>
          <div class="spike-bar-wrap">
            <div class="spike-bar ${severityClass(item.severity)}" style="width:${Math.min(100, Number(item.spike_percent) || 0)}%"></div>
          </div>
          <strong>${escapeHtml(item.spike_percent)}%</strong>
        </div>
      `).join("") || "<div class='meta-line'>Spike projection unavailable.</div>"}
    </div>
  `;
}

function renderWhatIfPlan(plan) {
  const comparison = buildSimulationComparison(plan, scenarioInput.value.trim());
  whatIfOutput.innerHTML = `
    <article class="alert-card severity-high">
      <strong>Strategy</strong>
      <div class="meta-line">${escapeHtml(present(plan.summary, "Scenario response plan generated."))}</div>
    </article>
    <div class="section-label">Baseline vs Simulated</div>
    <div class="comparison-grid">
      ${renderMetricTile("Open Needs", `${escapeHtml(present(comparison.baseline_open_needs, 0))} → ${escapeHtml(present(comparison.simulated_open_needs, 0))}`, "metric-danger")}
      ${renderMetricTile("Critical Needs", `${escapeHtml(present(comparison.baseline_critical_needs, 0))} → ${escapeHtml(present(comparison.simulated_critical_needs, 0))}`, "metric-danger")}
      ${renderMetricTile("Utilization", `${escapeHtml(present(comparison.baseline_utilization, 0))}% → ${escapeHtml(present(comparison.simulated_utilization, 0))}%`, "metric-warn")}
    </div>
    <div class="section-label">Immediate Actions</div>
    <div class="timeline-list">
      ${plan.immediate_actions ? plan.immediate_actions.map(action => `<div class="timeline-item severity-medium"><strong>Action</strong><div class="meta-line">${escapeHtml(action)}</div></div>`).join("") : ""}
    </div>
    ${plan.risk_notes ? `<div class="section-label">Risk Notes</div><div class="timeline-list">${plan.risk_notes.map(note => `<div class="timeline-item severity-high"><div class="meta-line">${escapeHtml(note)}</div></div>`).join("")}</div>` : ""}
  `;
}

function buildClientPredictionFallback(reportsText) {
  const lower = reportsText.toLowerCase();
  const hasWater = /water|drinking|sanitation|contaminated/.test(lower);
  const hasFlood = /flood|river|trapped|evacuate|rising/.test(lower);
  const hasMedical = /medical|insulin|diabetic|medicine|injured/.test(lower);

  let hidden_crisis_detected = "Multi-need stress may spill into nearby wards if response capacity stays fixed.";
  let forecast = "Demand is likely to rise for urgent supplies and field coordination within the next 6 hours.";
  let proactive_staging_recommendation = "Stage mixed relief kits and alert partner NGOs for overflow support.";

  if (hasWater && hasFlood) {
    hidden_crisis_detected = "Flood-linked water contamination may trigger displacement and water-borne illness clusters.";
    forecast = "Water purification, evacuation support, and emergency shelter demand are likely to spike in the next 6 hours.";
    proactive_staging_recommendation = "Pre-position rescue support, safe drinking water, and ORS supplies near the flood-affected corridor.";
  } else if (hasWater) {
    hidden_crisis_detected = "Potable water shortages may escalate into dehydration and disease risk across adjacent locations.";
    forecast = "Water access, sanitation support, and basic medical needs are likely to rise within the next 6 hours.";
    proactive_staging_recommendation = "Stage water cans, purification tablets, and hygiene kits close to the highest-demand zone.";
  } else if (hasMedical) {
    hidden_crisis_detected = "Delayed treatment for urgent medical cases may cascade into life-threatening emergencies.";
    forecast = "Time-sensitive medical demand and transport support are likely to increase within the next 6 hours.";
    proactive_staging_recommendation = "Alert nearby medical volunteers and stage emergency medicines near the highest-risk cluster.";
  }

  return {
    hidden_crisis_detected,
    forecast,
    proactive_staging_recommendation,
    six_hour_timeline: [
      { hour: "0-2h", category: hasFlood ? "rescue" : "medical", demand_level: "critical", drivers: "Immediate life-safety and response coordination pressure." },
      { hour: "2-4h", category: hasWater ? "water" : "food", demand_level: "high", drivers: "Basic relief demand rises as unresolved needs accumulate." },
      { hour: "4-6h", category: hasMedical ? "medical" : "shelter", demand_level: "high", drivers: "Delayed treatment and displacement risks intensify." }
    ],
    category_spikes: [
      { category: hasFlood ? "rescue" : "medical", spike_percent: 78, severity: "critical" },
      { category: hasWater ? "water" : "food", spike_percent: 61, severity: "high" },
      { category: hasMedical ? "medical" : "shelter", spike_percent: 48, severity: "medium" }
    ]
  };
}

async function getJsonOrThrow(response) {
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  let data = null;

  if (raw) {
    if (contentType.includes("application/json")) {
      data = JSON.parse(raw);
    } else {
      try {
        data = JSON.parse(raw);
      } catch {
        if (!response.ok) {
          throw new Error(`Server returned ${response.status} ${response.statusText}.`);
        }
        throw new Error("Server returned non-JSON content. Start the backend and retry.");
      }
    }
  }

  if (!response.ok) {
    throw new Error(data?.error || `Server error ${response.status}`);
  }

  return data;
}

function resetOutputs() {
  lastResult = null;
  metricsOutput.textContent = "Run allocation to generate real-time metrics.";
  predictionOutput.textContent = "Awaiting prediction trigger...";
  needsOutput.textContent = "Awaiting data...";
  assignmentsOutput.textContent = "Awaiting data...";
  rationaleOutput.textContent = "Awaiting data...";
  fairnessOutput.textContent = "Awaiting data...";
  whatIfOutput.textContent = "Awaiting simulation trigger...";
}

runBtn.addEventListener("click", async () => {
  const reportsText = reportsInput.value.trim();
  let volunteers = [];
  try { volunteers = JSON.parse(volunteersInput.value || "[]"); } 
  catch (e) { return statusEl.textContent = "Volunteer JSON error."; }

  if (!reportsText) return statusEl.textContent = "Please add field reports.";

  statusEl.textContent = "Running AI Decision Engine...";
  runBtn.disabled = true;

  try {
    const response = await fetch("/api/analyze-and-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportsText, volunteers })
    });

    const data = await getJsonOrThrow(response);
    lastResult = { ...data, volunteers };
    renderResults(data, volunteers);
    statusEl.textContent = "Intelligence layer optimized.";
  } catch (error) {
    statusEl.textContent = `Error: ${error.message}`;
  } finally {
    runBtn.disabled = false;
  }
});

// The Showstopper Feature
predictBtn.addEventListener("click", async () => {
  const reportsText = reportsInput.value.trim();
  if (!reportsText) return statusEl.textContent = "Input reports first.";

  predictBtn.disabled = true;
  statusEl.textContent = "Running predictive crisis forecast...";
  predictionOutput.innerHTML = "🔮 AI is analyzing data to forecast crises...";

  try {
    const response = await fetch("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportsText })
    });
    const data = await getJsonOrThrow(response);
    renderPrediction(data.prediction);
    statusEl.textContent = "Prediction complete.";
  } catch (error) {
    const fallbackPrediction = buildClientPredictionFallback(reportsText);
    renderPrediction(fallbackPrediction);
    statusEl.textContent = "Prediction fallback used. Check server logs after the demo.";
    console.error("[Predict] Error:", error);
  } finally {
    predictBtn.disabled = false;
  }
});

simulateBtn.addEventListener("click", async () => {
  if (!lastResult) return statusEl.textContent = "Run AI Engine first.";
  const scenario = scenarioInput.value.trim();
  if (!scenario) return;

  simulateBtn.disabled = true;
  whatIfOutput.textContent = "Simulating crisis escalation...";

  try {
    const response = await fetch("/api/what-if", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenario,
        rankedNeeds: lastResult.rankedNeeds || [],
        assignments: lastResult.assignments?.assignments || [],
        volunteers: JSON.parse(volunteersInput.value || "[]")
      })
    });
    const data = await getJsonOrThrow(response);
    renderWhatIfPlan(data.plan);
    statusEl.textContent = "Simulation complete.";
  } catch (error) {
    whatIfOutput.textContent = `Error: ${error.message}`;
  } finally {
    simulateBtn.disabled = false;
  }
});

reportsInput.value = "";
volunteersInput.value = "";
scenarioInput.value = "";
resetOutputs();
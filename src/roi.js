// ROI is a sizing model to validate before building more, not a claimed
// result — there's no field telemetry behind these numbers yet. Every
// input below is an assumption you'd replace with a real measurement
// (time a distributor's staff on actual manual intake, time a reviewer
// on the approve.js/web-UI flow) before this goes in front of anyone
// who'd hold you to it.
export function estimateROI({
  manualMinutesPerOrder = 25,   // phone calls + re-typing into Tally by hand — a typical distributor estimate, not measured
  agentMinutesPerOrder = 6,      // reviewing extracted lines + resolving ambiguity/stock in the approval UI
  ordersPerMonth = 400,
} = {}) {
  const minutesSavedPerOrder = manualMinutesPerOrder - agentMinutesPerOrder;
  const hoursSavedPerMonth = (minutesSavedPerOrder * ordersPerMonth) / 60;
  const workDaysSavedPerMonth = hoursSavedPerMonth / 8;

  return {
    manualMinutesPerOrder,
    agentMinutesPerOrder,
    minutesSavedPerOrder,
    ordersPerMonth,
    hoursSavedPerMonth: Number(hoursSavedPerMonth.toFixed(1)),
    workDaysSavedPerMonth: Number(workDaysSavedPerMonth.toFixed(2)),
  };
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z]+)=(-?\d+(\.\d+)?)$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const overrides = parseArgs(process.argv.slice(2));
  const r = estimateROI(overrides);

  console.log("ROI model — assumptions, not measured data (override with --manual=, --agent=, --orders=)\n");
  console.log(`  Manual intake:            ${r.manualMinutesPerOrder} min/order`);
  console.log(`  Agent-assisted (this app): ${r.agentMinutesPerOrder} min/order`);
  console.log(`  Saved per order:          ${r.minutesSavedPerOrder} min`);
  console.log(`  Volume:                   ${r.ordersPerMonth} orders/month`);
  console.log(`\n  => ${r.hoursSavedPerMonth} hours/month saved  (~${r.workDaysSavedPerMonth} working days)`);
}

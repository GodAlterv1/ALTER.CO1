/* eslint-disable no-console */
const baseUrl = (process.env.SMOKE_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

async function check(path) {
  try {
    const res = await fetch(`${baseUrl}${path}`);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: "offline" };
  }
}

async function main() {
  console.log("ALTER.CO Bug Bash Mode\n");
  console.log(`Target API: ${baseUrl}\n`);

  const health = await check("/api/health");
  console.log(`Backend reachability: ${health.ok ? "OK" : "NOT READY"} (${health.status})\n`);

  console.log("Run this sequence in the app and mark pass/fail:\n");
  const checklist = [
    "Auth: login, logout, and session restore after refresh.",
    "Calendar: create, edit, delete single event.",
    "Calendar recurring: edit/delete this occurrence vs entire series.",
    "Calendar drag-drop week view with Undo action.",
    "Calendar quick-add parser with at least 3 phrases.",
    "Google Calendar: connect, sync visible events, disconnect from Settings.",
    "Tasks: convert task to calendar event and verify timing/color.",
    "Docs/Projects/Team pages render with no console errors.",
    "Mobile viewport sanity check for landing + calendar controls."
  ];
  checklist.forEach((item, i) => console.log(`${i + 1}. ${item}`));

  console.log("\nRecommended command order:");
  console.log("1) npm run smoke");
  console.log("2) npm run bugbash");
  console.log("3) Manually execute checklist above and capture issues.\n");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});


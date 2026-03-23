/* eslint-disable no-console */
const baseUrl = (process.env.SMOKE_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

function step(name) {
  process.stdout.write(`- ${name} ... `);
}

function pass(extra) {
  console.log(`ok${extra ? ` (${extra})` : ""}`);
}

function fail(message, details) {
  console.log("failed");
  if (message) console.error(`  ${message}`);
  if (details) console.error(`  ${details}`);
  process.exitCode = 1;
}

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    body = text;
  }
  return { res, body };
}

async function main() {
  console.log(`ALTER.CO smoke suite -> ${baseUrl}`);

  step("Health endpoint");
  const health = await request("/api/health");
  if (!health.res.ok || !health.body || health.body.status !== "ok") {
    return fail("Health endpoint did not return status=ok", JSON.stringify(health.body));
  }
  pass();

  const nonce = Date.now().toString(36);
  const username = `smoke_${nonce}`;
  const password = `smoke_${nonce}_pw`;
  const email = `${username}@example.test`;

  step("Register temp user");
  const register = await request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password, fullName: "Smoke Test" })
  });
  if (!register.res.ok || !register.body || !register.body.token) {
    return fail("Register failed", JSON.stringify(register.body));
  }
  pass();

  step("Login temp user");
  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  if (!login.res.ok || !login.body || !login.body.token) {
    return fail("Login failed", JSON.stringify(login.body));
  }
  const token = login.body.token;
  pass();

  const authHeaders = { Authorization: `Bearer ${token}` };

  step("Read /api/me");
  const me = await request("/api/me", { headers: authHeaders });
  if (!me.res.ok || !me.body || me.body.username !== username) {
    return fail("Could not read profile", JSON.stringify(me.body));
  }
  pass();

  step("Read workspace");
  const wsBefore = await request("/api/workspace", { headers: authHeaders });
  if (!wsBefore.res.ok || !wsBefore.body || typeof wsBefore.body !== "object") {
    return fail("Could not read workspace", JSON.stringify(wsBefore.body));
  }
  pass();

  const marker = `smoke-${nonce}`;
  step("Write workspace marker");
  const wsPayload = { ...wsBefore.body, userSettings: { ...(wsBefore.body.userSettings || {}), smokeMarker: marker } };
  const wsPut = await request("/api/workspace", {
    method: "PUT",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(wsPayload)
  });
  if (!wsPut.res.ok) {
    return fail("Could not write workspace", JSON.stringify(wsPut.body));
  }
  pass();

  step("Verify workspace marker");
  const wsAfter = await request("/api/workspace", { headers: authHeaders });
  const markerRead = wsAfter.body && wsAfter.body.userSettings && wsAfter.body.userSettings.smokeMarker;
  if (!wsAfter.res.ok || markerRead !== marker) {
    return fail("Workspace marker round-trip failed", JSON.stringify(wsAfter.body));
  }
  pass();

  step("PATCH workspace userSettings (partial update)");
  const patchMarker = `${marker}-patch`;
  const patchUserSettings = { ...(wsAfter.body.userSettings || {}), smokePatchMarker: patchMarker };
  const patchBody = { value: patchUserSettings };
  const expectedAt =
    wsAfter.body._keyUpdatedAt && typeof wsAfter.body._keyUpdatedAt === "object"
      ? wsAfter.body._keyUpdatedAt.userSettings
      : "";
  if (expectedAt) patchBody.expectedUpdatedAt = String(expectedAt);
  const wsPatch = await request("/api/workspace/userSettings", {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(patchBody)
  });
  if (!wsPatch.res.ok || !wsPatch.body || !wsPatch.body.ok) {
    return fail("PATCH /api/workspace/:key failed", JSON.stringify(wsPatch.body));
  }
  const wsPatchRead = await request("/api/workspace", { headers: authHeaders });
  const patchRead =
    wsPatchRead.body && wsPatchRead.body.userSettings && wsPatchRead.body.userSettings.smokePatchMarker;
  if (!wsPatchRead.res.ok || patchRead !== patchMarker) {
    return fail("PATCH workspace round-trip failed", JSON.stringify(wsPatchRead.body));
  }
  pass();

  step("Google Calendar integration status");
  const calStatus = await request("/api/integrations/google/calendar/status", { headers: authHeaders });
  if (!calStatus.res.ok || !calStatus.body || typeof calStatus.body.connected !== "boolean") {
    return fail("Calendar status endpoint failed", JSON.stringify(calStatus.body));
  }
  pass(`configured=${Boolean(calStatus.body.configured)} connected=${calStatus.body.connected}`);

  step("Calendar events endpoint");
  const start = encodeURIComponent(new Date().toISOString());
  const end = encodeURIComponent(new Date(Date.now() + 7 * 86400000).toISOString());
  const calEvents = await request(`/api/calendar/events?start=${start}&end=${end}`, { headers: authHeaders });
  if (!calEvents.res.ok || !calEvents.body || !Array.isArray(calEvents.body.events)) {
    return fail("Calendar events endpoint failed", JSON.stringify(calEvents.body));
  }
  pass(`events=${calEvents.body.events.length}`);

  step("Delete temp user");
  const del = await request("/api/me", { method: "DELETE", headers: authHeaders });
  if (del.res.status !== 204) {
    return fail("Could not delete temp user", JSON.stringify(del.body));
  }
  pass();

  console.log("\nSmoke suite completed successfully.");
}

main().catch((err) => {
  console.error("\nSmoke suite crashed:");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});


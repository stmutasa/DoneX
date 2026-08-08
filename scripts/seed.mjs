// Seeds a running DoneX instance with demo data (for local dev / screenshots).
// Usage: node scripts/seed.mjs [baseUrl] [pin]
const BASE = process.argv[2] || "http://localhost:3000";
const PIN = process.argv[3] || "1234";
const TZ = "America/New_York";

let cookie = "";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  let json = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok && res.status !== 409) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  }
  return { status: res.status, json };
}

function atHour(daysFromNow, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const setup = await call("POST", "/api/auth/setup", { pin: PIN, tz: TZ });
if (setup.status === 409) await call("POST", "/api/auth/login", { pin: PIN });
console.log("authenticated");

const { json: pj } = await call("POST", "/api/projects", { name: "Home", icon: "🏡", color: "#4ADE80" });
const { json: pw } = await call("POST", "/api/projects", { name: "Work", icon: "💼", color: "#60A5FA" });
const { json: ph } = await call("POST", "/api/projects", { name: "Health", icon: "🌿", color: "#F472B6" });
console.log("projects created");

const mk = (t) => call("POST", "/api/tasks", t);

await mk({ title: "Review Q3 budget draft", dueAt: atHour(0, 11), priority: 3, projectId: pw?.project?.id, tags: ["finance"] });
const { json: groceries } = await mk({ title: "Grocery run", dueAt: atHour(0, 17, 30), priority: 2, projectId: pj?.project?.id, tags: ["errand"] });
if (groceries?.task?.id) {
  for (const s of ["Oat milk", "Coffee beans", "Blueberries"]) {
    await mk({ title: s, parentId: groceries.task.id });
  }
}
await mk({ title: "Morning jog — 5k", dueAt: atHour(0, 6, 30), projectId: ph?.project?.id, recurrence: { freq: "daily" }, tags: ["routine"] });
await mk({ title: "Call the dentist about Tuesday", dueAt: atHour(-1, 15), priority: 2, tags: ["phone"] });
await mk({ title: "Ship DoneX feedback notes", dueAt: atHour(1, 10), projectId: pw?.project?.id, priority: 2 });
await mk({ title: "Water the ficus", dueAt: atHour(2, 9), projectId: pj?.project?.id, recurrence: { freq: "weekly", byWeekday: [0, 3] } });
await mk({ title: "Renew passport", dueAt: atHour(6, 12), priority: 1 });
await mk({ title: "Read 'The Creative Act'", tags: ["someday"] });
const { json: doneTask } = await mk({ title: "Send birthday card to Sam", dueAt: atHour(0, 9) });
if (doneTask?.task?.id) await call("POST", `/api/tasks/${doneTask.task.id}/complete`, { done: true });
console.log("tasks created");

await call("POST", "/api/notes", {
  title: "Groceries",
  kind: "checklist",
  color: "sage",
  items: [
    { id: "1", text: "Oat milk", done: false },
    { id: "2", text: "Sourdough", done: true },
    { id: "3", text: "Peanut butter", done: false },
    { id: "4", text: "Spinach", done: false },
  ],
});
await call("POST", "/api/notes", {
  title: "Gift ideas",
  kind: "note",
  color: "violet",
  content: "Mom — ceramics class\nAlex — trail shoes\nSam — vinyl of that jazz record from the café",
  pinned: true,
});
await call("POST", "/api/notes", {
  title: "Weekend project ideas",
  kind: "note",
  color: "amber",
  content: "Build the raised garden bed\nRefinish the desk\nTry the new ramen place on 5th",
});
console.log("notes created");

await call("POST", "/api/inbox", { content: "Reminder: your dental cleaning is confirmed for Tue Aug 12 at 3:00 PM. Reply C to confirm." });
await call("POST", "/api/inbox", { content: "Package delivered: your order #4415 was left at the front door." });
console.log("inbox seeded");

console.log("✓ seed complete");

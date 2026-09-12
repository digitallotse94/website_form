import { createSign, timingSafeEqual } from "node:crypto";

export const maxDuration = 30;

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
const PROJECT_SHEET_RANGE = "Projekte!A:X";

type EnvironmentRecord = {
  id: string;
  status?: string;
  created?: string;
  updated?: string;
  last_accessed?: string;
  size_bytes?: string;
  file_count?: string;
};

type ProjectRecord = {
  rowNumber: number;
  submittedAt: string;
  companyName: string;
  contactName: string;
  email: string;
  industry: string;
  location: string;
  demoUrl: string;
  interactionId: string;
  environmentId: string;
  status: string;
};

type DashboardRow = {
  environment: EnvironmentRecord | null;
  project: ProjectRecord | null;
};

type ServiceAccount = {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
};

const BLOCKED_PROJECT_STATUSES = new Set([
  "received",
  "generating",
  "in_progress",
  "incomplete",
  "deploying",
]);

function base64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function dashboardCredentials(): { username: string; password: string } | null {
  const password = process.env.ADMIN_PASSWORD || process.env.WORKFLOW_SECRET;
  if (!password) return null;
  return {
    username: process.env.ADMIN_USERNAME || "admin",
    password,
  };
}

function isAuthorized(req: any): boolean {
  const credentials = dashboardCredentials();
  if (!credentials) return false;

  const authorization = String(req.headers?.authorization || "");
  if (!authorization.startsWith("Basic ")) return false;

  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return (
      safeEqual(decoded.slice(0, separator), credentials.username) &&
      safeEqual(decoded.slice(separator + 1), credentials.password)
    );
  } catch {
    return false;
  }
}

function requestOriginIsSameHost(req: any): boolean {
  const origin = String(req.headers?.origin || "");
  const host = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function unauthorized(res: any) {
  res.setHeader("WWW-Authenticate", 'Basic realm="Environment Dashboard", charset="UTF-8"');
  res.setHeader("Cache-Control", "no-store");
  return res.status(401).send("Anmeldung erforderlich");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatBytes(value?: string): string {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "–";
  const units = ["B", "KB", "MB", "GB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toLocaleString("de-DE", { maximumFractionDigits: 1 })} ${units[unit]}`;
}

function formatDate(value?: string): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(date);
}

function ageInHours(value?: string): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? (Date.now() - timestamp) / 3_600_000 : 0;
}

function googleHeaders(apiKey: string): Record<string, string> {
  return {
    "x-goog-api-key": apiKey,
    "Api-Revision": "2026-05-20",
  };
}

async function readResponseError(response: Response): Promise<string> {
  const text = await response.text();
  return text.slice(0, 1500);
}

async function listEnvironments(apiKey: string): Promise<EnvironmentRecord[]> {
  const environments: EnvironmentRecord[] = [];
  let pageToken = "";

  for (let page = 0; page < 10; page += 1) {
    const url = new URL(`${GOOGLE_API_BASE}/environments`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, { headers: googleHeaders(apiKey) });
    if (!response.ok) {
      throw new Error(`environment_list_failed_${response.status}_${await readResponseError(response)}`);
    }

    const body = (await response.json()) as any;
    for (const item of body.environments || []) {
      const id = String(item.environment_id || item.id || "").trim();
      if (id) environments.push({ ...item, id });
    }

    pageToken = String(body.next_page_token || body.nextPageToken || "");
    if (!pageToken) break;
  }

  return environments;
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) return null;
    return parsed;
  } catch {
    throw new Error("invalid_GOOGLE_SERVICE_ACCOUNT_JSON");
  }
}

async function createSheetsAccessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: account.token_uri || GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(String(account.private_key).replace(/\\n/g, "\n"));
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const response = await fetch(account.token_uri || GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`sheets_auth_failed_${response.status}_${await readResponseError(response)}`);
  }
  const body = (await response.json()) as any;
  if (!body.access_token) throw new Error("sheets_auth_missing_access_token");
  return String(body.access_token);
}

function cell(row: unknown[], index: number): string {
  return String(row[index] ?? "").trim();
}

async function loadProjects(): Promise<{ projects: ProjectRecord[]; configured: boolean }> {
  const account = loadServiceAccount();
  const spreadsheetId = process.env.PROJECTS_SPREADSHEET_ID;
  if (!account || !spreadsheetId) return { projects: [], configured: false };

  const accessToken = await createSheetsAccessToken(account);
  const range = encodeURIComponent(PROJECT_SHEET_RANGE);
  const response = await fetch(
    `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}?majorDimension=ROWS`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(`sheets_read_failed_${response.status}_${await readResponseError(response)}`);
  }

  const body = (await response.json()) as any;
  const rows: unknown[][] = Array.isArray(body.values) ? body.values : [];
  const firstLooksLikeHeader = cell(rows[0] || [], 2).toLowerCase().includes("company");
  const dataRows = firstLooksLikeHeader ? rows.slice(1) : rows;
  const offset = firstLooksLikeHeader ? 2 : 1;

  return {
    configured: true,
    projects: dataRows
      .map((row, index): ProjectRecord => ({
        rowNumber: index + offset,
        submittedAt: cell(row, 1),
        companyName: cell(row, 2),
        contactName: cell(row, 3),
        email: cell(row, 4),
        industry: cell(row, 8),
        location: cell(row, 9),
        demoUrl: cell(row, 18),
        interactionId: cell(row, 19),
        environmentId: cell(row, 20),
        status: cell(row, 21),
      }))
      .filter((project) => project.environmentId),
  };
}

function mergeRows(environments: EnvironmentRecord[], projects: ProjectRecord[]): DashboardRow[] {
  const environmentMap = new Map(environments.map((item) => [item.id, item]));
  const projectMap = new Map(projects.map((item) => [item.environmentId, item]));
  const ids = new Set([...environmentMap.keys(), ...projectMap.keys()]);

  return [...ids]
    .map((id) => ({
      environment: environmentMap.get(id) || null,
      project: projectMap.get(id) || null,
    }))
    .sort((a, b) => {
      if (!!a.environment !== !!b.environment) return a.environment ? -1 : 1;
      const aTime = a.environment?.last_accessed || a.environment?.updated || a.project?.submittedAt || "";
      const bTime = b.environment?.last_accessed || b.environment?.updated || b.project?.submittedAt || "";
      return bTime.localeCompare(aTime);
    });
}

function isProtected(row: DashboardRow): boolean {
  const status = row.project?.status.toLowerCase() || "";
  return BLOCKED_PROJECT_STATUSES.has(status);
}

function canForceDelete(row: DashboardRow): boolean {
  const lastActivity = row.environment?.last_accessed || row.environment?.updated || row.environment?.created;
  return ageInHours(lastActivity) >= 24;
}

function statusBadge(row: DashboardRow): string {
  if (!row.environment) return '<span class="badge badge-muted">bereits entfernt</span>';
  const projectStatus = row.project?.status || row.environment.status || "vorhanden";
  const blocked = isProtected(row);
  return `<span class="badge ${blocked ? "badge-warn" : "badge-ok"}">${escapeHtml(projectStatus)}</span>`;
}

function renderRows(rows: DashboardRow[]): string {
  if (!rows.length) {
    return '<tr><td colspan="8" class="empty">Keine Antigravity-Umgebungen gefunden.</td></tr>';
  }

  return rows
    .map((row) => {
      const env = row.environment;
      const project = row.project;
      const protectedRow = isProtected(row);
      const active = !!env;
      const unmatchedRow = active && !project;
      const forceAllowed = canForceDelete(row);
      const needsForce = protectedRow || unmatchedRow;
      const deleteMode = needsForce ? "force" : "normal";
      const deleteDisabled = !active || (needsForce && !forceAllowed);
      const deleteLabel = needsForce ? "Trotz Warnung löschen" : "Löschen";
      const deleteHint = !active
        ? "Diese Umgebung existiert nicht mehr."
        : needsForce && !forceAllowed
          ? "Nicht eindeutig freigegebene Umgebungen können erst nach 24 Stunden erzwungen gelöscht werden."
          : needsForce
            ? "Die Umgebung ist aktiv markiert oder keinem Projekt zugeordnet. Die Löschung erfordert eine zusätzliche Bestätigung."
            : "Umgebung endgültig löschen";
      const demoUrl = project?.demoUrl && /^https?:\/\//i.test(project.demoUrl)
        ? `<a href="${escapeHtml(project.demoUrl)}" target="_blank" rel="noreferrer">Demo öffnen</a>`
        : "–";

      return `<tr class="${active ? "" : "is-deleted"}">
        <td><strong>${escapeHtml(project?.companyName || "Nicht zugeordnet")}</strong><span class="sub">${escapeHtml([project?.industry, project?.location].filter(Boolean).join(" · ") || "–")}</span></td>
        <td>${statusBadge(row)}</td>
        <td><code title="${escapeHtml(env?.id || project?.environmentId || "")}">${escapeHtml(env?.id || project?.environmentId || "–")}</code></td>
        <td><code title="${escapeHtml(project?.interactionId || "")}">${escapeHtml(project?.interactionId || "–")}</code></td>
        <td>${escapeHtml(formatBytes(env?.size_bytes))}<span class="sub">${env?.file_count ? `${escapeHtml(env.file_count)} Dateien` : ""}</span></td>
        <td>${escapeHtml(formatDate(env?.last_accessed || env?.updated || env?.created || project?.submittedAt))}</td>
        <td>${demoUrl}</td>
        <td><button class="delete-button ${needsForce ? "danger-outline" : ""}" data-id="${escapeHtml(env?.id || "")}" data-company="${escapeHtml(project?.companyName || "Unbekanntes Projekt")}" data-mode="${deleteMode}" ${deleteDisabled ? "disabled" : ""} title="${escapeHtml(deleteHint)}">${escapeHtml(deleteLabel)}</button></td>
      </tr>`;
    })
    .join("");
}

function renderDashboard(rows: DashboardRow[], projectsConfigured: boolean): string {
  const liveCount = rows.filter((row) => row.environment).length;
  const totalBytes = rows.reduce((sum, row) => sum + Number(row.environment?.size_bytes || 0), 0);
  const unmatched = rows.filter((row) => row.environment && !row.project).length;
  const setupNotice = projectsConfigured
    ? ""
    : `<div class="notice"><strong>Projektzuordnung noch nicht verbunden.</strong> Die Antigravity-Umgebungen werden bereits angezeigt. Für Firmennamen, Projektstatus und Demo-Links fehlen noch <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> und <code>PROJECTS_SPREADSHEET_ID</code>.</div>`;

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>Antigravity-Umgebungen</title>
  <style>
    :root { color-scheme: light; --ink:#18201d; --muted:#64706b; --line:#dce3df; --surface:#fff; --soft:#f4f7f5; --green:#146c43; --green-soft:#e8f5ee; --amber:#925f00; --amber-soft:#fff4d8; --danger:#b42318; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--soft); color:var(--ink); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
    main { width:min(1480px,calc(100% - 32px)); margin:48px auto; }
    header { display:flex; gap:24px; justify-content:space-between; align-items:end; margin-bottom:24px; }
    h1 { margin:0 0 5px; font-size:clamp(26px,4vw,40px); letter-spacing:-.03em; }
    .lead,.sub { color:var(--muted); }
    .lead { margin:0; }
    .summary { display:flex; gap:24px; padding:14px 18px; background:var(--surface); border:1px solid var(--line); border-radius:12px; white-space:nowrap; }
    .summary strong { display:block; font-size:19px; }
    .summary span { color:var(--muted); font-size:12px; }
    .notice { margin-bottom:16px; padding:14px 16px; border:1px solid #e8c76e; border-radius:10px; background:#fff9e9; }
    .table-wrap { overflow:auto; background:var(--surface); border:1px solid var(--line); border-radius:14px; box-shadow:0 10px 30px rgba(28,48,39,.05); }
    table { width:100%; min-width:1120px; border-collapse:collapse; }
    th,td { padding:15px 14px; text-align:left; border-bottom:1px solid var(--line); vertical-align:top; }
    th { position:sticky; top:0; background:#f8faf9; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
    tr:last-child td { border-bottom:0; }
    tr:hover td { background:#fbfcfb; }
    .sub { display:block; margin-top:3px; font-size:12px; }
    code { display:block; max-width:180px; overflow:hidden; text-overflow:ellipsis; font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace; color:#34413c; }
    a { color:var(--green); font-weight:650; }
    .badge { display:inline-block; padding:4px 8px; border-radius:999px; font-size:12px; font-weight:700; }
    .badge-ok { color:var(--green); background:var(--green-soft); }
    .badge-warn { color:var(--amber); background:var(--amber-soft); }
    .badge-muted { color:var(--muted); background:#edf1ef; }
    button { border:0; border-radius:8px; padding:9px 12px; background:var(--danger); color:#fff; font:inherit; font-weight:700; cursor:pointer; }
    button:hover { filter:brightness(.94); }
    button:disabled { opacity:.38; cursor:not-allowed; }
    .danger-outline { color:var(--danger); background:#fff; box-shadow:inset 0 0 0 1px #e4a19b; }
    .is-deleted { opacity:.62; }
    .empty { padding:48px; text-align:center; color:var(--muted); }
    #message { min-height:24px; margin-top:14px; font-weight:650; }
    #message.error { color:var(--danger); }
    @media (max-width:760px) { main { margin:24px auto; } header { align-items:start; flex-direction:column; } .summary { width:100%; justify-content:space-between; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><h1>Antigravity-Umgebungen</h1><p class="lead">Projektzuordnung prüfen und alte Entwicklungsumgebungen gezielt entfernen.</p></div>
      <div class="summary"><div><strong>${liveCount}</strong><span>vorhanden</span></div><div><strong>${escapeHtml(formatBytes(String(totalBytes)))}</strong><span>belegter Speicher</span></div><div><strong>${unmatched}</strong><span>nicht zugeordnet</span></div></div>
    </header>
    ${setupNotice}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Projekt</th><th>Status</th><th>Environment-ID</th><th>Interaction-ID</th><th>Speicher</th><th>Letzte Aktivität</th><th>Demo</th><th>Aktion</th></tr></thead>
        <tbody>${renderRows(rows)}</tbody>
      </table>
    </div>
    <p id="message" role="status" aria-live="polite"></p>
  </main>
  <script>
    document.addEventListener('click', async function (event) {
      const button = event.target.closest('.delete-button');
      if (!button || button.disabled) return;
      const id = button.dataset.id;
      const company = button.dataset.company;
      const force = button.dataset.mode === 'force';
      const warning = force
        ? 'WARNUNG: Die Umgebung ist noch aktiv markiert oder keinem Projekt zugeordnet. Nur fortfahren, wenn der Auftrag sicher nicht mehr läuft.\\n\\n'
        : '';
      if (!confirm(warning + 'Antigravity-Umgebung für „' + company + '“ endgültig löschen?\\n\\n' + id)) return;
      button.disabled = true;
      button.textContent = 'Wird gelöscht …';
      const message = document.getElementById('message');
      message.className = '';
      message.textContent = '';
      try {
        const response = await fetch(location.pathname, {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ environment_id: id, force })
        });
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.message || body.error || 'Löschen fehlgeschlagen');
        message.textContent = 'Umgebung wurde gelöscht. Ansicht wird aktualisiert …';
        setTimeout(function () { location.reload(); }, 700);
      } catch (error) {
        message.className = 'error';
        message.textContent = error && error.message ? error.message : String(error);
        button.disabled = false;
        button.textContent = force ? 'Trotz Warnung löschen' : 'Löschen';
      }
    });
  </script>
</body>
</html>`;
}

async function loadDashboardData(apiKey: string): Promise<{ rows: DashboardRow[]; projectsConfigured: boolean }> {
  const [environments, projectResult] = await Promise.all([listEnvironments(apiKey), loadProjects()]);
  return {
    rows: mergeRows(environments, projectResult.projects),
    projectsConfigured: projectResult.configured,
  };
}

async function deleteEnvironment(req: any, res: any, apiKey: string) {
  if (!requestOriginIsSameHost(req)) {
    return res.status(403).json({ ok: false, error: "invalid_origin", message: "Ungültige Anfragequelle." });
  }

  const environmentId = typeof req.body?.environment_id === "string" ? req.body.environment_id.trim() : "";
  const force = req.body?.force === true;
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(environmentId)) {
    return res.status(400).json({ ok: false, error: "invalid_environment_id", message: "Ungültige Environment-ID." });
  }

  const { rows } = await loadDashboardData(apiKey);
  const row = rows.find((item) => item.environment?.id === environmentId);
  if (!row?.environment) {
    return res.status(404).json({ ok: false, error: "environment_not_found", message: "Die Umgebung wurde nicht gefunden oder bereits gelöscht." });
  }

  if (isProtected(row)) {
    if (!force) {
      return res.status(409).json({ ok: false, error: "active_project", message: "Der Projektstatus wirkt noch aktiv. Die Löschung wurde blockiert." });
    }
    if (!canForceDelete(row)) {
      return res.status(409).json({ ok: false, error: "environment_too_recent", message: "Aktive oder junge Umgebungen können frühestens nach 24 Stunden erzwungen gelöscht werden." });
    }
  }

  if (!row.project) {
    if (!force) {
      return res.status(409).json({ ok: false, error: "unmatched_environment", message: "Die Umgebung ist keinem Projekt zugeordnet. Eine ausdrückliche Bestätigung ist erforderlich." });
    }
    if (!canForceDelete(row)) {
      return res.status(409).json({ ok: false, error: "environment_too_recent", message: "Nicht zugeordnete Umgebungen können frühestens nach 24 Stunden erzwungen gelöscht werden." });
    }
  }

  const response = await fetch(`${GOOGLE_API_BASE}/environments/${encodeURIComponent(environmentId)}`, {
    method: "DELETE",
    headers: googleHeaders(apiKey),
  });
  if (!response.ok && response.status !== 404) {
    return res.status(502).json({
      ok: false,
      error: "environment_delete_failed",
      message: `Antigravity hat die Löschung abgelehnt (${response.status}).`,
    });
  }

  return res.status(200).json({ ok: true, environment_id: environmentId, already_deleted: response.status === 404 });
}

export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");

  if (!dashboardCredentials()) {
    return res.status(503).send("ADMIN_PASSWORD oder WORKFLOW_SECRET ist nicht konfiguriert.");
  }
  if (!isAuthorized(req)) return unauthorized(res);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).send("GEMINI_API_KEY ist nicht konfiguriert.");

  try {
    if (req.method === "DELETE") return await deleteEnvironment(req, res, apiKey);
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, DELETE");
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }

    const { rows, projectsConfigured } = await loadDashboardData(apiKey);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(renderDashboard(rows, projectsConfigured));
  } catch (error) {
    console.error("Environment dashboard failed", error);
    const message = error instanceof Error ? error.message : String(error);
    return res.status(502).json({ ok: false, error: "dashboard_failed", message });
  }
}

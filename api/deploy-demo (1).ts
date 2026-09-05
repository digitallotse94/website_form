// DEPLOY_DEMO_ARCHIVE_V3_2026_09_01
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const config = { maxDuration: 300 };

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const VERCEL_API_BASE = "https://api.vercel.com";
const ANTIGRAVITY_AGENT = "antigravity-preview-05-2026";
const EXPORT_PATH = "workspace/site-export.tar.gz";
const MAX_FILES = 400;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;
const EXPORT_POLL_INTERVAL_MS = 3000;
const EXPORT_WAIT_TIMEOUT_MS = 180_000;
const EXPORT_MAX_CONTINUATIONS = 2;

interface InteractionResponse {
  id?: string;
  status?: string;
  environment_id?: string;
  output_text?: string | null;
  error?: unknown;
}

interface DeployableFile {
  deployPath: string;
  content: Buffer;
  sha: string;
}

interface SiteValidation {
  homeEntry: string;
  companyMarkerFound: boolean;
}

const HOME_ENTRY_PATTERNS = [
  /^(?:app|src\/app)\/page\.(?:tsx|ts|jsx|js)$/i,
  /^(?:pages|src\/pages)\/index\.(?:tsx|ts|jsx|js)$/i,
];

const SOURCE_FILE_PATTERN = /\.(?:tsx|ts|jsx|js|html|css|scss|mdx|json)$/i;

const STARTER_MARKERS = [
  "to get started, edit the",
  "create next app",
  'src="/next.svg"',
  'src="/vercel.svg"',
  "vercel.com/templates?framework=next.js",
  "nextjs.org/learn",
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_env_${name}`);
  return value;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function encodePathSegments(value: string): string {
  return normalizePath(value)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function readErrorResponse(response: Response): Promise<string> {
  const text = await response.text();
  return text.slice(0, 5000);
}

function googleHeaders(apiKey: string, json = false): Record<string, string> {
  const headers: Record<string, string> = {
    "x-goog-api-key": apiKey,
    "Api-Revision": "2026-05-20",
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

async function createExportInteraction(
  previousInteractionId: string,
  environmentId: string,
  apiKey: string,
): Promise<InteractionResponse> {
  const prompt = `Create a compact deployment archive for the already finished website.\n\nRun this exact operation in the existing environment:\n1. Verify /workspace/site/package.json exists. If not, stop and report an error.\n2. Remove any previous /workspace/site-export.tar.gz.\n3. Create /workspace/site-export.tar.gz from the CONTENTS of /workspace/site, excluding generated/reinstallable or secret files: node_modules, .next, .git, .vercel, .cache, .turbo, coverage, dist, .env*, .npmrc, .DS_Store, and *.log.\n4. Do NOT modify source files. Do NOT rebuild. Do NOT install packages. Do NOT deploy.\n5. Verify the archive exists and is non-empty, then report its byte size.\n\nUse tar/gzip. The archive must unpack directly to package.json, app/src/etc. rather than containing a top-level workspace/site directory.`;

  const response = await fetch(`${GOOGLE_API_BASE}/interactions`, {
    method: "POST",
    headers: googleHeaders(apiKey, true),
    body: JSON.stringify({
      agent: ANTIGRAVITY_AGENT,
      input: prompt,
      previous_interaction_id: previousInteractionId,
      environment: environmentId,
      background: true,
      agent_config: {
        type: "antigravity",
        max_total_tokens: 30000,
      },
    }),
  });

  if (!response.ok) {
    const details = await readErrorResponse(response);
    throw new Error(`export_interaction_create_failed_${response.status}_${details}`);
  }

  return (await response.json()) as InteractionResponse;
}

async function continueExportInteraction(
  previousInteractionId: string,
  environmentId: string,
  apiKey: string,
): Promise<InteractionResponse> {
  const prompt = `Continue and finish the existing deployment archive export.

1. Reuse all work already completed in the current environment.
2. If /workspace/site-export.tar.gz already exists and is non-empty, verify it and finish.
3. Otherwise create the archive from the CONTENTS of /workspace/site with the same exclusions as before.
4. Do not modify source files, rebuild, install packages, or deploy.
5. Finish only when the archive exists and is non-empty, then report its byte size.`;

  const response = await fetch(`${GOOGLE_API_BASE}/interactions`, {
    method: "POST",
    headers: googleHeaders(apiKey, true),
    body: JSON.stringify({
      agent: ANTIGRAVITY_AGENT,
      input: prompt,
      previous_interaction_id: previousInteractionId,
      environment: environmentId,
      background: true,
      agent_config: {
        type: "antigravity",
        max_total_tokens: 30000,
      },
    }),
  });

  if (!response.ok) {
    const details = await readErrorResponse(response);
    throw new Error(`export_interaction_continue_failed_${response.status}_${details}`);
  }

  return (await response.json()) as InteractionResponse;
}

async function getInteraction(id: string, apiKey: string): Promise<InteractionResponse> {
  const response = await fetch(`${GOOGLE_API_BASE}/interactions/${encodeURIComponent(id)}`, {
    headers: googleHeaders(apiKey),
  });
  if (!response.ok) {
    const details = await readErrorResponse(response);
    throw new Error(`export_interaction_get_failed_${response.status}_${details}`);
  }
  return (await response.json()) as InteractionResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInteraction(
  interaction: InteractionResponse,
  environmentId: string,
  apiKey: string,
): Promise<InteractionResponse> {
  if (!interaction.id) throw new Error("export_interaction_missing_id");

  let current = interaction;
  let continuations = 0;
  const deadline = Date.now() + EXPORT_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    while (current.status === "in_progress" && Date.now() < deadline) {
      await sleep(EXPORT_POLL_INTERVAL_MS);
      if (!current.id) throw new Error("export_interaction_missing_id");
      current = await getInteraction(current.id, apiKey);
    }

    if (current.status === "completed") {
      return current;
    }

    if (
      current.status === "incomplete" &&
      continuations < EXPORT_MAX_CONTINUATIONS &&
      Date.now() < deadline
    ) {
      if (!current.id) throw new Error("export_interaction_missing_id");
      continuations += 1;
      console.info("deploy-demo continuing incomplete export", {
        previousInteractionId: current.id,
        continuation: continuations,
      });
      current = await continueExportInteraction(current.id, environmentId, apiKey);
      continue;
    }

    throw new Error(
      `export_interaction_not_completed_${current.status || "unknown"}_${JSON.stringify(current.error || null)}`,
    );
  }

  throw new Error("export_interaction_timeout");
}

async function downloadEnvironmentFile(
  environmentId: string,
  filePath: string,
  apiKey: string,
): Promise<Buffer> {
  const encodedPath = encodePathSegments(filePath);
  const url = `${GOOGLE_API_BASE}/environments/${encodeURIComponent(environmentId)}/files/${encodedPath}?alt=media`;

  let lastError = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(url, {
      headers: googleHeaders(apiKey),
      redirect: "follow",
    });

    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) throw new Error("export_archive_empty");
      if (buffer.length > MAX_ARCHIVE_BYTES) {
        throw new Error(`export_archive_too_large_${buffer.length}`);
      }
      return buffer;
    }

    lastError = await readErrorResponse(response);
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 4) {
      throw new Error(`export_archive_download_failed_${response.status}_${lastError}`);
    }
    await sleep(attempt * 1500);
  }

  throw new Error(`export_archive_download_failed_${lastError}`);
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  return buffer
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/s, "")
    .trim();
}

function readTarOctal(buffer: Buffer, start: number, length: number): number {
  const raw = readTarString(buffer, start, length).replace(/\s/g, "");
  if (!raw) return 0;
  const parsed = parseInt(raw, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parsePaxPath(data: Buffer): string | null {
  const text = data.toString("utf8");
  for (const line of text.split("\n")) {
    const match = line.match(/^\d+\s+path=(.*)$/);
    if (match) return match[1];
  }
  return null;
}

function shouldExcludeDeployPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const parts = normalized.split("/");
  const excludedDirectories = new Set([
    "node_modules",
    ".next",
    ".git",
    ".vercel",
    ".cache",
    ".turbo",
    "coverage",
    "dist",
  ]);
  if (parts.some((part) => excludedDirectories.has(part))) return true;
  const fileName = parts[parts.length - 1] || "";
  return (
    fileName === ".DS_Store" ||
    fileName === ".npmrc" ||
    fileName.startsWith(".env") ||
    fileName.endsWith(".log")
  );
}

function parseTarGz(archive: Buffer): DeployableFile[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch (error) {
    throw new Error(`export_archive_gunzip_failed_${error instanceof Error ? error.message : String(error)}`);
  }

  const files: DeployableFile[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const size = readTarOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] || 48);
    const prefix = readTarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if (dataEnd > tar.length) throw new Error("export_archive_truncated");
    const data = tar.subarray(dataStart, dataEnd);

    if (typeFlag === "L") {
      pendingLongName = data.toString("utf8").replace(/\0.*$/s, "").trim();
    } else if (typeFlag === "x") {
      pendingPaxPath = parsePaxPath(data);
    } else if (typeFlag === "0" || typeFlag === "\0") {
      const rawPath = pendingPaxPath || pendingLongName || headerPath;
      pendingLongName = null;
      pendingPaxPath = null;
      const deployPath = normalizePath(rawPath);

      if (deployPath && !shouldExcludeDeployPath(deployPath)) {
        const content = Buffer.from(data);
        files.push({
          deployPath,
          content,
          sha: createHash("sha1").update(content).digest("hex"),
        });
      }
    }

    const paddedSize = Math.ceil(size / 512) * 512;
    offset = dataStart + paddedSize;
  }

  if (files.length === 0) throw new Error("no_deployable_files_found_in_export");
  if (files.length > MAX_FILES) throw new Error(`too_many_deployable_files_${files.length}`);

  const totalBytes = files.reduce((sum, file) => sum + file.content.length, 0);
  if (totalBytes > MAX_SOURCE_BYTES) throw new Error(`source_files_too_large_${totalBytes}`);
  if (!files.some((file) => file.deployPath === "package.json")) {
    throw new Error("package_json_not_found_in_export");
  }

  return files;
}

export function validateDeployableSite(
  files: DeployableFile[],
  companyName: string,
): SiteValidation {
  if (!companyName) throw new Error("company_name_required_for_validation");
  if (companyName.toLowerCase() === "automated demo") {
    throw new Error("placeholder_company_name_not_allowed");
  }

  const nestedPackageJson = files.find(
    (file) => file.deployPath !== "package.json" && file.deployPath.endsWith("/package.json"),
  );
  if (nestedPackageJson) {
    throw new Error(`nested_project_detected_${nestedPackageJson.deployPath}`);
  }

  const homeEntries = files
    .map((file) => file.deployPath)
    .filter((filePath) => HOME_ENTRY_PATTERNS.some((pattern) => pattern.test(filePath)));

  if (homeEntries.length === 0) throw new Error("active_home_page_not_found");
  if (homeEntries.length > 1) {
    throw new Error(`multiple_active_home_pages_${homeEntries.join(",")}`);
  }

  const sourceFiles = files.filter((file) => SOURCE_FILE_PATTERN.test(file.deployPath));
  const sourceText = sourceFiles
    .map((file) => file.content.toString("utf8"))
    .join("\n")
    .toLowerCase();

  const starterMarker = STARTER_MARKERS.find((marker) => sourceText.includes(marker));
  if (starterMarker) {
    throw new Error(`default_starter_content_detected_${starterMarker.replace(/[^a-z0-9]+/g, "_")}`);
  }

  const normalizedCompanyName = companyName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const normalizedSourceText = sourceText
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ");
  const companyTokens = normalizedCompanyName
    .split(/\s+/)
    .filter((token) => token.length >= 2);
  const companyMarkerFound =
    normalizedCompanyName.length > 0 &&
    (normalizedSourceText.includes(normalizedCompanyName) ||
      (companyTokens.length > 0 &&
        companyTokens.every((token) => normalizedSourceText.includes(token))));
  if (!companyMarkerFound) {
    throw new Error("company_name_not_found_in_site_source");
  }

  return {
    homeEntry: homeEntries[0],
    companyMarkerFound,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => runWorker()),
  );
  return results;
}

function teamQuery(teamId: string): string {
  return `teamId=${encodeURIComponent(teamId)}`;
}

async function uploadFileToVercel(
  file: DeployableFile,
  token: string,
  teamId: string,
): Promise<void> {
  const response = await fetch(`${VERCEL_API_BASE}/v2/files?${teamQuery(teamId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.content.length),
      "x-vercel-digest": file.sha,
    },
    body: file.content.buffer.slice(
      file.content.byteOffset,
      file.content.byteOffset + file.content.byteLength,
    ) as ArrayBuffer,
  });

  if (!response.ok) {
    const details = await readErrorResponse(response);
    throw new Error(`vercel_file_upload_failed_${response.status}_${file.deployPath}_${details}`);
  }
}

async function uploadFilesToVercel(
  files: DeployableFile[],
  token: string,
  teamId: string,
): Promise<void> {
  await mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (file) => {
    await uploadFileToVercel(file, token, teamId);
    return true;
  });
}

async function getVercelProject(projectName: string, token: string, teamId: string): Promise<any | null> {
  const response = await fetch(
    `${VERCEL_API_BASE}/v9/projects/${encodeURIComponent(projectName)}?${teamQuery(teamId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const details = await readErrorResponse(response);
    throw new Error(`vercel_project_lookup_failed_${response.status}_${details}`);
  }
  return response.json();
}

async function ensureVercelProject(projectName: string, token: string, teamId: string): Promise<any> {
  const existing = await getVercelProject(projectName, token, teamId);
  if (existing) return existing;

  const response = await fetch(`${VERCEL_API_BASE}/v9/projects?${teamQuery(teamId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: projectName, framework: "nextjs" }),
  });
  if (!response.ok) {
    const details = await readErrorResponse(response);
    throw new Error(`vercel_project_creation_failed_${response.status}_${details}`);
  }
  return response.json();
}

async function createVercelDeployment(
  projectName: string,
  files: DeployableFile[],
  token: string,
  teamId: string,
  companyName?: string,
): Promise<any> {
  const body: Record<string, unknown> = {
    name: projectName,
    files: files.map((file) => ({
      file: file.deployPath,
      sha: file.sha,
      size: file.content.length,
    })),
    projectSettings: { framework: "nextjs" },
  };
  if (companyName?.trim()) {
    body.meta = { company_name: companyName.trim() };
  }

  const response = await fetch(`${VERCEL_API_BASE}/v13/deployments?${teamQuery(teamId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const details = await readErrorResponse(response);
    throw new Error(`vercel_deployment_failed_${response.status}_${details}`);
  }
  return response.json();
}

export default async function handler(req: any, res: any) {
  let stage = "request_received";
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    stage = "authenticate";
    console.info("deploy-demo stage", stage);
    const workflowSecret = requireEnv("WORKFLOW_SECRET");
    const suppliedSecret = req.headers["x-workflow-secret"];
    if (typeof suppliedSecret !== "string" || suppliedSecret !== workflowSecret) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const geminiApiKey = requireEnv("GEMINI_API_KEY");
    const vercelToken = requireEnv("VERCEL_TOKEN");
    const vercelTeamId = requireEnv("VERCEL_TEAM_ID");
    const projectName = process.env.VERCEL_DEMO_PROJECT || "website-demos";

    const previousInteractionId =
      typeof req.body?.interaction_id === "string" ? req.body.interaction_id.trim() : "";
    const environmentId =
      typeof req.body?.environment_id === "string" ? req.body.environment_id.trim() : "";
    const companyName =
      typeof req.body?.company_name === "string" ? req.body.company_name.trim() : "";

    if (!previousInteractionId) {
      return res.status(400).json({ ok: false, error: "missing_interaction_id" });
    }
    if (!environmentId) {
      return res.status(400).json({ ok: false, error: "missing_environment_id" });
    }
    if (!companyName) {
      return res.status(400).json({ ok: false, error: "missing_company_name" });
    }
    if (companyName.toLowerCase() === "automated demo") {
      return res.status(400).json({ ok: false, error: "placeholder_company_name_not_allowed" });
    }

    stage = "create_export_interaction";
    console.info("deploy-demo stage", stage, { environmentId });
    const exportInteraction = await createExportInteraction(
      previousInteractionId,
      environmentId,
      geminiApiKey,
    );
    stage = "wait_export_interaction";
    console.info("deploy-demo stage", stage, { exportInteractionId: exportInteraction.id, status: exportInteraction.status });
    const completedExport = await waitForInteraction(exportInteraction, environmentId, geminiApiKey);
    console.info("deploy-demo export completed", { id: completedExport.id, status: completedExport.status });

    stage = "download_export_archive";
    console.info("deploy-demo stage", stage, { path: EXPORT_PATH });
    const archive = await downloadEnvironmentFile(environmentId, EXPORT_PATH, geminiApiKey);
    console.info("deploy-demo archive downloaded", { bytes: archive.length });
    stage = "parse_export_archive";
    const files = parseTarGz(archive);
    console.info("deploy-demo archive parsed", { files: files.length });

    stage = "validate_site_source";
    const validation = validateDeployableSite(files, companyName);
    console.info("deploy-demo site source validated", validation);

    stage = "ensure_vercel_project";
    await ensureVercelProject(projectName, vercelToken, vercelTeamId);
    stage = "upload_vercel_files";
    await uploadFilesToVercel(files, vercelToken, vercelTeamId);
    stage = "create_vercel_deployment";
    const deployment = await createVercelDeployment(
      projectName,
      files,
      vercelToken,
      vercelTeamId,
      companyName,
    );

    const deploymentUrl = deployment?.url ? `https://${deployment.url}` : null;
    const sourceBytes = files.reduce((sum, file) => sum + file.content.length, 0);

    return res.status(202).json({
      ok: true,
      deployment_id: deployment?.id || null,
      deployment_url: deploymentUrl,
      deployment_status: deployment?.readyState || deployment?.status || "INITIALIZING",
      project_id: deployment?.projectId || deployment?.project?.id || null,
      source_file_count: files.length,
      source_bytes: sourceBytes,
      export_archive_bytes: archive.length,
      export_interaction_id: completedExport.id || null,
      export_status: completedExport.status || null,
      validated_home_entry: validation.homeEntry,
      company_marker_found: validation.companyMarkerFound,
    });
  } catch (error: unknown) {
    console.error("Demo deployment failed", error);
    return res.status(502).json({
      ok: false,
      error: "demo_deployment_failed",
      stage,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

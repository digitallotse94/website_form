import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHash } from "node:crypto";

export const config = { maxDuration: 300 };

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const VERCEL_API_BASE = "https://api.vercel.com";
const MAX_FILES = 400;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

type EnvironmentFile = {
  created?: string;
  mime_type?: string;
  modified?: string;
  name?: string;
  path?: string;
  size_bytes?: string;
  type?: "file" | "directory" | string;
};

type EnvironmentFilesResponse = {
  files?: EnvironmentFile[];
  next_page_token?: string;
};

type DeployableFile = {
  sourcePath: string;
  deployPath: string;
  size: number;
  content?: Buffer;
  sha?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_env_${name}`);
  return value;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function encodePathSegments(value: string): string {
  return normalizePath(value)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildEnvironmentFileUrl(
  environmentId: string,
  filePath: string,
  query?: URLSearchParams,
): string {
  const encodedEnvironmentId = encodeURIComponent(environmentId);
  const encodedPath = encodePathSegments(filePath);
  const base = `${GOOGLE_API_BASE}/environments/${encodedEnvironmentId}/files/${encodedPath}`;
  const suffix = query && query.toString() ? `?${query.toString()}` : "";
  return `${base}${suffix}`;
}

function shouldExcludeDeployPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const parts = normalized.split("/");
  const excludedDirectories = new Set([
    "node_modules", ".next", ".git", ".vercel", ".cache", ".turbo", "coverage", "dist",
  ]);
  if (parts.some((part) => excludedDirectories.has(part))) return true;
  const fileName = parts[parts.length - 1] || "";
  return (
    fileName === ".DS_Store" ||
    fileName === ".npmrc" ||
    fileName.endsWith(".log") ||
    fileName.startsWith(".env")
  );
}

async function readErrorResponse(response: Response): Promise<string> {
  const text = await response.text();
  return text.slice(0, 4000);
}

async function getEnvironment(environmentId: string, apiKey: string): Promise<any> {
  const response = await fetch(
    `${GOOGLE_API_BASE}/environments/${encodeURIComponent(environmentId)}`,
    { headers: { "x-goog-api-key": apiKey } },
  );
  if (!response.ok) {
    const details = await readErrorResponse(response);
    throw new Error(`environment_get_failed_${response.status}_${details}`);
  }
  return response.json();
}

async function listEnvironmentFiles(
  environmentId: string,
  directoryPath: string,
  apiKey: string,
): Promise<EnvironmentFile[]> {
  const allFiles: EnvironmentFile[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams();
    params.set("recursive", "true");
    params.set("page_size", "1000");
    if (pageToken) params.set("page_token", pageToken);
    const url = buildEnvironmentFileUrl(environmentId, directoryPath, params);
    const response = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
    if (!response.ok) {
      const details = await readErrorResponse(response);
      throw new Error(`environment_files_list_failed_${response.status}_${details}`);
    }
    const body = (await response.json()) as EnvironmentFilesResponse;
    if (Array.isArray(body.files)) allFiles.push(...body.files);
    pageToken = body.next_page_token || "";
  } while (pageToken);
  return allFiles;
}

async function downloadEnvironmentFile(
  environmentId: string,
  filePath: string,
  apiKey: string,
): Promise<Buffer> {
  const params = new URLSearchParams();
  params.set("alt", "media");
  const url = buildEnvironmentFileUrl(environmentId, filePath, params);
  const response = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
  if (!response.ok) {
    const details = await readErrorResponse(response);
    throw new Error(`environment_file_download_failed_${response.status}_${filePath}_${details}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function selectDeployableFiles(listedFiles: EnvironmentFile[]): DeployableFile[] {
  const sitePrefix = "workspace/site/";
  const selected = listedFiles
    .filter((entry) => entry.type === "file")
    .map((entry) => ({
      sourcePath: normalizePath(entry.path || ""),
      size: Number(entry.size_bytes || 0),
    }))
    .filter((entry) => entry.sourcePath.startsWith(sitePrefix))
    .map((entry) => ({
      sourcePath: entry.sourcePath,
      deployPath: entry.sourcePath.slice(sitePrefix.length),
      size: entry.size,
    }))
    .filter((entry) => Boolean(entry.deployPath))
    .filter((entry) => !shouldExcludeDeployPath(entry.deployPath));

  if (selected.length === 0) throw new Error("no_deployable_files_found");
  if (selected.length > MAX_FILES) throw new Error(`too_many_deployable_files_${selected.length}`);

  const totalBytes = selected.reduce((sum, file) => sum + Math.max(0, file.size), 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`source_files_too_large_${totalBytes}`);
  if (!selected.some((file) => file.deployPath === "package.json")) {
    throw new Error("package_json_not_found");
  }
  return selected;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => runWorker()),
  );
  return results;
}

async function hydrateDeployableFiles(
  environmentId: string,
  files: DeployableFile[],
  apiKey: string,
): Promise<DeployableFile[]> {
  const hydrated = await mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (file) => {
    const content = await downloadEnvironmentFile(environmentId, file.sourcePath, apiKey);
    const sha = createHash("sha1").update(content).digest("hex");
    return { ...file, size: content.length, content, sha };
  });
  const totalBytes = hydrated.reduce((sum, file) => sum + (file.content?.length || 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`downloaded_source_files_too_large_${totalBytes}`);
  }
  return hydrated;
}

function teamQuery(teamId: string): string {
  return `teamId=${encodeURIComponent(teamId)}`;
}

async function uploadFileToVercel(
  file: DeployableFile,
  token: string,
  teamId: string,
): Promise<void> {
  if (!file.content || !file.sha) throw new Error(`missing_file_content_${file.deployPath}`);
  const response = await fetch(`${VERCEL_API_BASE}/v2/files?${teamQuery(teamId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.content.length),
      "x-vercel-digest": file.sha,
    },
    body: file.content,
  });
  if (!response.ok) {
    const details = await readErrorResponse(response);
    throw new Error(`vercel_file_upload_failed_${response.status}_${file.deployPath}_${details}`);
  }
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
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
  const body: Record<string, any> = {
    name: projectName,
    files: files.map((file) => ({
      file: file.deployPath,
      sha: file.sha,
      size: file.content?.length || file.size,
    })),
    projectSettings: { framework: "nextjs" },
  };
  if (companyName && companyName.trim()) {
    body.meta = { company_name: companyName.trim() };
  }
  const response = await fetch(`${VERCEL_API_BASE}/v13/deployments?${teamQuery(teamId)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const details = await readErrorResponse(response);
    throw new Error(`vercel_deployment_failed_${response.status}_${details}`);
  }
  return response.json();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    const workflowSecret = requireEnv("WORKFLOW_SECRET");
    const suppliedSecret = req.headers["x-workflow-secret"];
    if (typeof suppliedSecret !== "string" || suppliedSecret !== workflowSecret) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const geminiApiKey = requireEnv("GEMINI_API_KEY");
    const vercelToken = requireEnv("VERCEL_TOKEN");
    const vercelTeamId = requireEnv("VERCEL_TEAM_ID");
    const projectName = process.env.VERCEL_DEMO_PROJECT || "website-demos";

    const environmentId = typeof req.body?.environment_id === "string" ? req.body.environment_id.trim() : "";
    const companyName = typeof req.body?.company_name === "string" ? req.body.company_name.trim() : "";

    if (!environmentId) {
      return res.status(400).json({ ok: false, error: "missing_environment_id" });
    }

    const environment = await getEnvironment(environmentId, geminiApiKey);
    const listedFiles = await listEnvironmentFiles(environmentId, "workspace/site", geminiApiKey);
    const selectedFiles = selectDeployableFiles(listedFiles);
    const hydratedFiles = await hydrateDeployableFiles(environmentId, selectedFiles, geminiApiKey);

    await ensureVercelProject(projectName, vercelToken, vercelTeamId);
    await mapWithConcurrency(hydratedFiles, UPLOAD_CONCURRENCY, async (file) => {
      await uploadFileToVercel(file, vercelToken, vercelTeamId);
      return true;
    });

    const deployment = await createVercelDeployment(
      projectName,
      hydratedFiles,
      vercelToken,
      vercelTeamId,
      companyName,
    );

    return res.status(202).json({
      ok: true,
      deployment_id: deployment?.id || null,
      deployment_url: deployment?.url ? `https://${deployment.url}` : null,
      deployment_status: deployment?.readyState || deployment?.status || "INITIALIZING",
      project_id: deployment?.projectId || deployment?.project?.id || null,
      source_file_count: hydratedFiles.length,
      source_bytes: hydratedFiles.reduce((sum, file) => sum + (file.content?.length || 0), 0),
      environment_status: environment?.status || null,
      environment_size_bytes: environment?.size_bytes || null,
    });
  } catch (error: any) {
    console.error("Demo deployment failed", error);
    return res.status(502).json({
      ok: false,
      error: "demo_deployment_failed",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

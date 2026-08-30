import { createHash } from "node:crypto";

export const maxDuration = 300;

type EnvironmentFile = {
  name?: string;
  path?: string;
  type?: "file" | "directory";
  size_bytes?: string;
  mime_type?: string;
};

const GOOGLE_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta";

const VERCEL_API_BASE = "https://api.vercel.com";

const MAX_FILES = 400;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

function shouldIncludeFile(fullPath: string) {
  const prefix = "workspace/site/";

  if (!fullPath.startsWith(prefix)) {
    return false;
  }

  const relativePath = fullPath.slice(prefix.length);

  if (!relativePath || relativePath.includes("..")) {
    return false;
  }

  const ignoredPrefixes = [
    "node_modules/",
    ".next/",
    ".git/",
    ".vercel/",
    ".cache/",
    ".turbo/",
    "coverage/",
    "dist/",
  ];

  if (ignoredPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
    return false;
  }

  const fileName = relativePath.split("/").pop() ?? "";

  if (
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    fileName === ".npmrc" ||
    fileName === ".DS_Store" ||
    fileName.endsWith(".log")
  ) {
    return false;
  }

  return true;
}

async function listEnvironmentFiles(
  environmentId: string,
  geminiApiKey: string
): Promise<EnvironmentFile[]> {
  const files: EnvironmentFile[] = [];
  let pageToken = "";

  do {
    const url = new URL(
      `${GOOGLE_API_BASE}/environments/${encodeURIComponent(
        environmentId
      )}/files`
    );

    url.searchParams.set("path", "workspace/site");
    url.searchParams.set("recursive", "true");
    url.searchParams.set("page_size", "1000");

    if (pageToken) {
      url.searchParams.set("page_token", pageToken);
    }

    const response = await fetch(url, {
      headers: {
        "x-goog-api-key": geminiApiKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `environment_file_list_failed_${response.status}`
      );
    }

    const data = await response.json();

    if (Array.isArray(data.files)) {
      files.push(...data.files);
    }

    pageToken =
      typeof data.next_page_token === "string"
        ? data.next_page_token
        : "";
  } while (pageToken);

  return files;
}

async function downloadEnvironmentFile(
  environmentId: string,
  filePath: string,
  geminiApiKey: string
) {
  const url = new URL(
    `${GOOGLE_API_BASE}/environments/${encodeURIComponent(
      environmentId
    )}/files`
  );

  url.searchParams.set("path", filePath);
  url.searchParams.set("alt", "media");

  const response = await fetch(url, {
    headers: {
      "x-goog-api-key": geminiApiKey,
    },
  });

  if (!response.ok) {
    throw new Error(
      `environment_file_download_failed_${response.status}_${filePath}`
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function uploadFileToVercel(
  fileBuffer: Buffer,
  relativePath: string,
  vercelToken: string,
  teamId: string
) {
  const sha = createHash("sha1")
    .update(fileBuffer)
    .digest("hex");

  const url = new URL(`${VERCEL_API_BASE}/v2/files`);
  url.searchParams.set("teamId", teamId);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${vercelToken}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(fileBuffer.byteLength),
      "x-vercel-digest": sha,
    },
    body: fileBuffer,
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `vercel_file_upload_failed_${response.status}_${relativePath}_${errorText}`
    );
  }

  return {
    file: relativePath,
    sha,
    size: fileBuffer.byteLength,
  };
}

async function ensureVercelProject(
  projectName: string,
  vercelToken: string,
  teamId: string
) {
  const projectUrl = new URL(
    `${VERCEL_API_BASE}/v9/projects/${encodeURIComponent(projectName)}`
  );

  projectUrl.searchParams.set("teamId", teamId);

  const existingResponse = await fetch(projectUrl, {
    headers: {
      Authorization: `Bearer ${vercelToken}`,
    },
  });

  if (existingResponse.ok) {
    return existingResponse.json();
  }

  if (existingResponse.status !== 404) {
    throw new Error(
      `vercel_project_lookup_failed_${existingResponse.status}`
    );
  }

  const createUrl = new URL(`${VERCEL_API_BASE}/v9/projects`);
  createUrl.searchParams.set("teamId", teamId);

  const createResponse = await fetch(createUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${vercelToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: projectName,
      framework: "nextjs",
    }),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();

    throw new Error(
      `vercel_project_creation_failed_${createResponse.status}_${errorText}`
    );
  }

  return createResponse.json();
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "method_not_allowed",
    });
  }

  const workflowSecret = process.env.WORKFLOW_SECRET;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const vercelToken = process.env.VERCEL_TOKEN;
  const vercelTeamId = process.env.VERCEL_TEAM_ID;

  const demoProject =
    process.env.VERCEL_DEMO_PROJECT || "website-demos";

  if (
    !workflowSecret ||
    !geminiApiKey ||
    !vercelToken ||
    !vercelTeamId
  ) {
    return res.status(500).json({
      ok: false,
      error: "missing_server_configuration",
    });
  }

  if (req.headers["x-workflow-secret"] !== workflowSecret) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }

  const environmentId =
    typeof req.body?.environment_id === "string"
      ? req.body.environment_id.trim()
      : "";

  const companyName =
    typeof req.body?.company_name === "string"
      ? req.body.company_name.trim()
      : "";

  if (!environmentId) {
    return res.status(400).json({
      ok: false,
      error: "missing_environment_id",
    });
  }

  try {
    const allEnvironmentFiles =
      await listEnvironmentFiles(
        environmentId,
        geminiApiKey
      );

    const sourceFiles = allEnvironmentFiles.filter(
      (file) =>
        file.type === "file" &&
        typeof file.path === "string" &&
        shouldIncludeFile(file.path)
    );

    if (sourceFiles.length === 0) {
      return res.status(422).json({
        ok: false,
        error: "no_deployable_files_found",
      });
    }

    if (sourceFiles.length > MAX_FILES) {
      return res.status(413).json({
        ok: false,
        error: "too_many_source_files",
        file_count: sourceFiles.length,
      });
    }

    const totalBytes = sourceFiles.reduce(
      (sum, file) =>
        sum + Number(file.size_bytes ?? 0),
      0
    );

    if (totalBytes > MAX_TOTAL_BYTES) {
      return res.status(413).json({
        ok: false,
        error: "source_project_too_large",
        total_bytes: totalBytes,
      });
    }

    const hasPackageJson = sourceFiles.some(
      (file) =>
        file.path === "workspace/site/package.json"
    );

    if (!hasPackageJson) {
      return res.status(422).json({
        ok: false,
        error: "package_json_missing",
      });
    }

    const project = await ensureVercelProject(
      demoProject,
      vercelToken,
      vercelTeamId
    );

    const uploadedFiles: Array<{
      file: string;
      sha: string;
      size: number;
    }> = [];

    for (
      let i = 0;
      i < sourceFiles.length;
      i += UPLOAD_CONCURRENCY
    ) {
      const batch = sourceFiles.slice(
        i,
        i + UPLOAD_CONCURRENCY
      );

      const results = await Promise.all(
        batch.map(async (file) => {
          const fullPath = file.path!;

          const relativePath = fullPath.replace(
            /^workspace\/site\//,
            ""
          );

          const buffer =
            await downloadEnvironmentFile(
              environmentId,
              fullPath,
              geminiApiKey
            );

          return uploadFileToVercel(
            buffer,
            relativePath,
            vercelToken,
            vercelTeamId
          );
        })
      );

      uploadedFiles.push(...results);
    }

    const deploymentUrl = new URL(
      `${VERCEL_API_BASE}/v13/deployments`
    );

    deploymentUrl.searchParams.set(
      "teamId",
      vercelTeamId
    );

    deploymentUrl.searchParams.set(
      "forceNew",
      "1"
    );

    deploymentUrl.searchParams.set(
      "skipAutoDetectionConfirmation",
      "1"
    );

    const deploymentResponse = await fetch(
      deploymentUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${vercelToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: demoProject,
          project: project.id,
          files: uploadedFiles,

          projectSettings: {
            framework: "nextjs",
          },

          meta: {
            source: "antigravity",
            environment_id: environmentId,
            company_name: companyName,
          },
        }),
      }
    );

    const deployment =
      await deploymentResponse.json();

    if (!deploymentResponse.ok) {
      throw new Error(
        `vercel_deployment_failed_${
          deploymentResponse.status
        }_${JSON.stringify(deployment)}`
      );
    }

    return res.status(202).json({
      ok: true,

      deployment_id:
        deployment.id ??
        deployment.uid ??
        null,

      deployment_url:
        deployment.url
          ? `https://${deployment.url}`
          : null,

      deployment_status:
        deployment.readyState ??
        deployment.status ??
        "QUEUED",

      project_id: project.id,

      source_file_count:
        uploadedFiles.length,

      source_bytes: totalBytes,
    });
  } catch (error) {
    console.error("Demo deployment failed", error);

    return res.status(502).json({
      ok: false,
      error: "demo_deployment_failed",
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}

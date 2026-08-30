import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const maxDuration = 300;

const VERCEL_API_BASE = "https://api.vercel.com";

const MAX_FILES = 400;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 600 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

type TarFile = {
  path: string;
  data: Buffer;
};

function normalizeTarPath(path: string) {
  return path
    .replace(/^\.?\//, "")
    .replace(/^\/+/, "");
}

function shouldIncludeFile(fullPath: string) {
  const normalized = normalizeTarPath(fullPath);
  const prefix = "workspace/site/";

  if (!normalized.startsWith(prefix)) {
    return false;
  }

  const relativePath = normalized.slice(prefix.length);

  if (!relativePath || relativePath.includes("..")) {
    return false;
  }

  const ignored = [
    "node_modules/",
    ".next/",
    ".git/",
    ".vercel/",
    ".cache/",
    ".turbo/",
    "coverage/",
    "dist/",
  ];

  if (ignored.some((item) => relativePath.startsWith(item))) {
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

function parseOctal(buffer: Buffer) {
  const value = buffer
    .toString("utf8")
    .replace(/\0/g, "")
    .trim();

  if (!value) return 0;

  return parseInt(value, 8) || 0;
}

function parsePax(data: Buffer) {
  const result: Record<string, string> = {};
  let offset = 0;

  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);

    if (space === -1) break;

    const length = parseInt(
      data.toString("utf8", offset, space),
      10
    );

    if (!length || length <= 0) break;

    const record = data
      .toString(
        "utf8",
        space + 1,
        offset + length
      )
      .replace(/\n$/, "");

    const equals = record.indexOf("=");

    if (equals > 0) {
      result[record.slice(0, equals)] =
        record.slice(equals + 1);
    }

    offset += length;
  }

  return result;
}

function parseTar(input: Buffer): TarFile[] {
  let tar = input;

  // Falls Google irgendwann gzip statt reinem TAR liefert.
  if (
    tar.length >= 2 &&
    tar[0] === 0x1f &&
    tar[1] === 0x8b
  ) {
    tar = gunzipSync(tar);
  }

  const files: TarFile[] = [];

  let offset = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);

    const empty = header.every((byte) => byte === 0);

    if (empty) break;

    const name = header
      .subarray(0, 100)
      .toString("utf8")
      .replace(/\0.*$/, "");

    const prefix = header
      .subarray(345, 500)
      .toString("utf8")
      .replace(/\0.*$/, "");

    const size = parseOctal(
      header.subarray(124, 136)
    );

    const typeFlag =
      String.fromCharCode(header[156] || 48);

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if (dataEnd > tar.length) {
      throw new Error("invalid_tar_archive");
    }

    const data = tar.subarray(
      dataStart,
      dataEnd
    );

    const defaultPath = prefix
      ? `${prefix}/${name}`
      : name;

    if (typeFlag === "L") {
      longName = data
        .toString("utf8")
        .replace(/\0.*$/, "")
        .trim();
    } else if (typeFlag === "x") {
      const pax = parsePax(data);

      if (pax.path) {
        paxPath = pax.path;
      }
    } else {
      const path =
        paxPath ??
        longName ??
        defaultPath;

      // Reguläre Datei
      if (
        typeFlag === "0" ||
        typeFlag === "\0"
      ) {
        if (shouldIncludeFile(path)) {
          const normalized =
            normalizeTarPath(path);

          files.push({
            path: normalized.replace(
              /^workspace\/site\//,
              ""
            ),
            data,
          });
        }
      }

      longName = null;
      paxPath = null;
    }

    const paddedSize =
      Math.ceil(size / 512) * 512;

    offset =
      dataStart + paddedSize;
  }

  return files;
}

async function downloadEnvironmentSnapshot(
  environmentId: string,
  geminiApiKey: string
) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/files/` +
    `environment-${encodeURIComponent(environmentId)}:download?alt=media`;

  const response = await fetch(url, {
    headers: {
      "x-goog-api-key": geminiApiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `environment_snapshot_download_failed_${response.status}_${errorText}`
    );
  }

  const declaredSize = Number(
    response.headers.get("content-length") ?? 0
  );

  if (
    declaredSize &&
    declaredSize > MAX_SNAPSHOT_BYTES
  ) {
    throw new Error(
      `environment_snapshot_too_large_${declaredSize}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (buffer.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      `environment_snapshot_too_large_${buffer.byteLength}`
    );
  }

  return buffer;
}

async function uploadFileToVercel(
  file: TarFile,
  vercelToken: string,
  teamId: string
) {
  const sha = createHash("sha1")
    .update(file.data)
    .digest("hex");

  const url = new URL(
    `${VERCEL_API_BASE}/v2/files`
  );

  url.searchParams.set("teamId", teamId);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${vercelToken}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(
        file.data.byteLength
      ),
      "x-vercel-digest": sha,
    },
    body: file.data,
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `vercel_file_upload_failed_${response.status}_${file.path}_${errorText}`
    );
  }

  return {
    file: file.path,
    sha,
    size: file.data.byteLength,
  };
}

async function ensureVercelProject(
  projectName: string,
  vercelToken: string,
  teamId: string
) {
  const getUrl = new URL(
    `${VERCEL_API_BASE}/v9/projects/${encodeURIComponent(
      projectName
    )}`
  );

  getUrl.searchParams.set("teamId", teamId);

  const existing = await fetch(getUrl, {
    headers: {
      Authorization: `Bearer ${vercelToken}`,
    },
  });

  if (existing.ok) {
    return existing.json();
  }

  if (existing.status !== 404) {
    throw new Error(
      `vercel_project_lookup_failed_${existing.status}`
    );
  }

  const createUrl = new URL(
    `${VERCEL_API_BASE}/v9/projects`
  );

  createUrl.searchParams.set(
    "teamId",
    teamId
  );

  const created = await fetch(createUrl, {
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

  if (!created.ok) {
    const errorText = await created.text();

    throw new Error(
      `vercel_project_creation_failed_${created.status}_${errorText}`
    );
  }

  return created.json();
}

export default async function handler(
  req: any,
  res: any
) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "method_not_allowed",
    });
  }

  const workflowSecret =
    process.env.WORKFLOW_SECRET;

  const geminiApiKey =
    process.env.GEMINI_API_KEY;

  const vercelToken =
    process.env.VERCEL_TOKEN;

  const vercelTeamId =
    process.env.VERCEL_TEAM_ID;

  const demoProject =
    process.env.VERCEL_DEMO_PROJECT ||
    "website-demos";

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

  if (
    req.headers["x-workflow-secret"] !==
    workflowSecret
  ) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }

  const environmentId =
    typeof req.body?.environment_id ===
    "string"
      ? req.body.environment_id.trim()
      : "";

  const companyName =
    typeof req.body?.company_name ===
    "string"
      ? req.body.company_name.trim()
      : "";

  if (!environmentId) {
    return res.status(400).json({
      ok: false,
      error: "missing_environment_id",
    });
  }

  try {
    const snapshot =
      await downloadEnvironmentSnapshot(
        environmentId,
        geminiApiKey
      );

    const sourceFiles =
      parseTar(snapshot);

    if (!sourceFiles.length) {
      return res.status(422).json({
        ok: false,
        error: "no_deployable_files_found",
        snapshot_bytes:
          snapshot.byteLength,
      });
    }

    if (sourceFiles.length > MAX_FILES) {
      return res.status(413).json({
        ok: false,
        error: "too_many_source_files",
        file_count: sourceFiles.length,
      });
    }

    const totalBytes =
      sourceFiles.reduce(
        (sum, file) =>
          sum + file.data.byteLength,
        0
      );

    if (totalBytes > MAX_SOURCE_BYTES) {
      return res.status(413).json({
        ok: false,
        error: "source_project_too_large",
        source_bytes: totalBytes,
      });
    }

    if (
      !sourceFiles.some(
        (file) =>
          file.path === "package.json"
      )
    ) {
      return res.status(422).json({
        ok: false,
        error: "package_json_missing",
        files: sourceFiles
          .slice(0, 20)
          .map((file) => file.path),
      });
    }

    const project =
      await ensureVercelProject(
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
      const batch =
        sourceFiles.slice(
          i,
          i + UPLOAD_CONCURRENCY
        );

      const uploaded =
        await Promise.all(
          batch.map((file) =>
            uploadFileToVercel(
              file,
              vercelToken,
              vercelTeamId
            )
          )
        );

      uploadedFiles.push(...uploaded);
    }

    const deployUrl = new URL(
      `${VERCEL_API_BASE}/v13/deployments`
    );

    deployUrl.searchParams.set(
      "teamId",
      vercelTeamId
    );

    deployUrl.searchParams.set(
      "forceNew",
      "1"
    );

    deployUrl.searchParams.set(
      "skipAutoDetectionConfirmation",
      "1"
    );

    const deploymentResponse =
      await fetch(deployUrl, {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${vercelToken}`,
          "Content-Type":
            "application/json",
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
            environment_id:
              environmentId,
            company_name:
              companyName,
          },
        }),
      });

    const deployment =
      await deploymentResponse.json();

    if (!deploymentResponse.ok) {
      throw new Error(
        `vercel_deployment_failed_${deploymentResponse.status}_${JSON.stringify(
          deployment
        )}`
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

      source_bytes:
        totalBytes,

      snapshot_bytes:
        snapshot.byteLength,
    });
  } catch (error) {
    console.error(
      "Demo deployment failed",
      error
    );

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

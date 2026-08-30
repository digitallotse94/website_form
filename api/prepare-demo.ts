import { GoogleGenAI } from "@google/genai";

export const maxDuration = 300;

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "method_not_allowed",
    });
  }

  const workflowSecret = process.env.WORKFLOW_SECRET;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!workflowSecret || !geminiApiKey) {
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

  const interactionId =
    typeof req.body?.interaction_id === "string"
      ? req.body.interaction_id.trim()
      : "";

  const environmentId =
    typeof req.body?.environment_id === "string"
      ? req.body.environment_id.trim()
      : "";

  if (!interactionId || !environmentId) {
    return res.status(400).json({
      ok: false,
      error: "missing_interaction_or_environment_id",
    });
  }

  const ai = new GoogleGenAI({
    apiKey: geminiApiKey,
  });

  try {
    const cleanup = await ai.interactions.create({
      agent: "antigravity-preview-05-2026",

      previous_interaction_id: interactionId,
      environment: environmentId,

      input: `
Bereite die bereits fertiggestellte Website ausschließlich für den Export vor.

WICHTIG:
Die Website wurde bereits erfolgreich gebaut.
Keine Inhalte, Komponenten, Styles oder Quelldateien mehr verändern.

Führe ausschließlich folgende Aufräumarbeiten aus:

1. Prüfe kurz die Größe von /workspace/site.
2. Lösche ausschließlich generierte oder erneut installierbare Verzeichnisse unter /workspace/site:

- node_modules
- .next
- .cache
- .turbo
- coverage
- dist

3. Lösche KEINE dieser Dateien/Verzeichnisse:
- package.json
- package-lock.json
- pnpm-lock.yaml
- yarn.lock
- app
- src
- components
- public
- styles
- Konfigurationsdateien
- sonstige Quelldateien

4. Prüfe danach erneut die Größe von /workspace/site.

5. KEINEN neuen Build durchführen.
6. KEINE Dependencies neu installieren.
7. KEINE Deployment-Schritte durchführen.

Ziel ist ausschließlich, die bereits geprüfte Website für einen möglichst kleinen Export vorzubereiten.

Antworte danach kurz mit:
- Cleanup erfolgreich: ja/nein
- Größe vorher
- Größe nachher
`,

      agent_config: {
        type: "antigravity",
        model: "gemini-3.7-flash",
        max_total_tokens: 12000,
      },

      tools: [
        {
          type: "code_execution",
        },
      ],
    });

    return res.status(200).json({
      ok: true,

      interaction_id: cleanup.id,

      environment_id:
        cleanup.environment_id ?? environmentId,

      status: cleanup.status,

      output_text:
        cleanup.output_text ?? null,
    });
  } catch (error) {
    console.error(
      "Antigravity deploy preparation failed",
      error
    );

    return res.status(502).json({
      ok: false,
      error: "prepare_demo_failed",
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}

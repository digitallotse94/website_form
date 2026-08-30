import { GoogleGenAI } from "@google/genai";

export const maxDuration = 30;

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

  const providedSecret = req.headers["x-workflow-secret"];

  if (providedSecret !== workflowSecret) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }

  const interactionId =
    typeof req.body?.interaction_id === "string"
      ? req.body.interaction_id.trim()
      : "";

  if (!interactionId) {
    return res.status(400).json({
      ok: false,
      error: "missing_interaction_id",
    });
  }

  const ai = new GoogleGenAI({
    apiKey: geminiApiKey,
  });

  try {
    const interaction = await ai.interactions.get(interactionId);

    const status = interaction.status ?? "unknown";

    const isFinished =
      status === "completed" ||
      status === "failed" ||
      status === "cancelled";

    const needsAction = status === "requires_action";

    return res.status(200).json({
      ok: true,

      interaction_id: interaction.id,
      environment_id: interaction.environment_id ?? null,

      status,

      is_finished: isFinished,
      needs_action: needsAction,

      output_text:
        status === "completed"
          ? interaction.output_text ?? null
          : null,

      error:
        status === "failed"
          ? interaction.error ?? null
          : null,
    });
  } catch (error) {
    console.error("Antigravity status check failed", error);

    return res.status(502).json({
      ok: false,
      error: "antigravity_status_check_failed",
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}

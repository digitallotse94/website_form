import { GoogleGenAI } from "@google/genai";

export const maxDuration = 60;

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

  const environmentId =
    typeof req.body?.environment_id === "string"
      ? req.body.environment_id.trim()
      : "";

  const companyName =
    typeof req.body?.company_name === "string"
      ? req.body.company_name.trim()
      : "";

  if (!interactionId || !environmentId || !companyName) {
    return res.status(400).json({
      ok: false,
      error: "missing_interaction_environment_or_company_name",
    });
  }

  const ai = new GoogleGenAI({
    apiKey: geminiApiKey,
  });

  try {
    const continuation = await ai.interactions.create({
      agent: "antigravity-preview-05-2026",

      previous_interaction_id: interactionId,
      environment: environmentId,

      input: `
Setze die bestehende Website-Erstellung fort.

Die bisherige Arbeit im vorhandenen Environment soll weiterverwendet werden.

PRIORITÄTEN:

1. Keine unnötigen neuen Features oder Designideen mehr hinzufügen.
2. Die bereits begonnene Website vollständig fertigstellen.
3. Fehlende Komponenten oder notwendige Inhalte ergänzen.
4. Alle Dependencies prüfen.
5. Den Produktions-Build ausführen.
6. Auftretende Build-Fehler selbstständig beheben.
7. Den Build erneut ausführen, bis er erfolgreich ist.
8. Sicherstellen, dass die fertige Website vollständig unter /workspace/site liegt.
9. Keine Deployment-Schritte durchführen.
10. Keine Unternehmensfakten erfinden.
11. Kein zweites oder verschachteltes Projekt und keine zweite package.json
    unter /workspace/site erstellen.
12. Die bereits aktive Startseite ersetzen: app/page.* oder src/app/page.*
    beziehungsweise beim Pages Router pages/index.* oder src/pages/index.*.
    Niemals mehrere konkurrierende Startseiten anlegen.
13. Sicherstellen, dass alle erstellten Komponenten von der aktiven Route /
    importiert und dort sichtbar gerendert werden.
14. Die Next.js-/Vercel-Starteroberfläche vollständig entfernen.
15. Nach dem erfolgreichen Build die gebaute Website lokal starten, / per HTTP
    abrufen und anschließend den Testserver wieder beenden.
16. Im HTML der Route / muss der Unternehmensname "${companyName}" vorkommen.
17. Im HTML der Route / dürfen "To get started", "Create Next App",
    "/next.svg" und "/vercel.svg" nicht vorkommen.

Ziel dieses Durchgangs ist ausschließlich:
FERTIGSTELLEN → BUILD PRÜFEN → FEHLER BEHEBEN → ABSCHLIESSEN.

Wenn der Build erfolgreich ist, keine weiteren Änderungen mehr vornehmen.

Gib am Ende eine kurze Zusammenfassung mit:
- Build erfolgreich: ja/nein
- verwendeter Stack
- verbleibende Platzhalter
- eventuell noch vorhandene technische Probleme
`,

      agent_config: {
        type: "antigravity",
        model: "gemini-3.7-flash",
        max_total_tokens: 60000,
      },

      background: true,
    });

    return res.status(202).json({
      ok: true,

      previous_interaction_id: interactionId,

      interaction_id: continuation.id,
      environment_id:
        continuation.environment_id ?? environmentId,

      status: continuation.status ?? "in_progress",
      company_name: companyName,
    });
  } catch (error) {
    console.error("Antigravity continuation failed", error);

    return res.status(502).json({
      ok: false,
      error: "antigravity_continuation_failed",
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}

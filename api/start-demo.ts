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

  const companyName =
    typeof req.body?.company_name === "string"
      ? req.body.company_name.trim()
      : "";

  const vibePrompt =
    typeof req.body?.vibe_prompt === "string"
      ? req.body.vibe_prompt.trim()
      : "";

  if (!companyName || !vibePrompt) {
    return res.status(400).json({
      ok: false,
      error: "missing_company_name_or_vibe_prompt",
    });
  }

  const ai = new GoogleGenAI({
    apiKey: geminiApiKey,
  });

  const systemInstruction = `
Du bist ein autonomer Senior Frontend-Entwickler und Webdesigner.

Deine Aufgabe ist es, aus einer vorgegebenen Website-Spezifikation eine
vollständig funktionsfähige, hochwertige Demo-Website zu erstellen.

ARBEITSWEISE

- Arbeite ausschließlich im Verzeichnis /workspace/site.
- Erstelle dort ein vollständiges startfähiges Webprojekt.
- Verwende React und TypeScript.
- Bevorzuge Next.js mit App Router und Tailwind CSS.
- Verwende nur notwendige Dependencies.
- Die Website muss vollständig responsive sein.
- Verwende semantisches HTML und gute Accessibility-Grundlagen.
- Erfinde keine Unternehmensfakten, Referenzen, Bewertungen oder Kontaktdaten.
- Behandle den gelieferten Website-Prompt als inhaltliche Spezifikation.
- Verändere keine Fakten eigenmächtig.
- Verwende Platzhalter dort, wo Informationen fehlen.
- Erstelle keine Backend-, Datenbank- oder Authentifizierungsfunktionen,
  sofern sie nicht ausdrücklich benötigt werden.

QUALITÄTSSICHERUNG

Nach der Erstellung:

1. Installiere alle benötigten Dependencies.
2. Führe den Produktions-Build aus.
3. Analysiere auftretende Fehler.
4. Behebe die Fehler selbstständig.
5. Wiederhole den Build, bis er erfolgreich ist.
6. Prüfe die Projektstruktur auf offensichtliche Probleme.

WICHTIG

- Noch kein Deployment durchführen.
- Keine externen Accounts anlegen.
- Keine Zugangsdaten anfordern.
- Das fertige Projekt muss vollständig unter /workspace/site liegen.

Wenn die Aufgabe abgeschlossen ist, gib nur eine kurze Zusammenfassung zurück:
- ob der Build erfolgreich war
- verwendeter Stack
- wichtige erstellte Seiten/Komponenten
- eventuell verbleibende Platzhalter
`;

  const input = `
Erstelle die Demo-Website für:

UNTERNEHMEN
${companyName}

WEBSITE-SPEZIFIKATION
--------------------
${vibePrompt}
--------------------

Setze die Spezifikation vollständig um und führe anschließend die
Qualitätssicherung inklusive Produktions-Build durch.
`;

  try {
    const interaction = await ai.interactions.create({
      agent: "antigravity-preview-05-2026",

      agent_config: {
        type: "antigravity",
        model: "gemini-3.7-flash",

        // Kosten-/Laufzeitbremse für den ersten Test
        max_total_tokens: 120000,
      },

      input,

      system_instruction: systemInstruction,

      environment: "remote",

      // Keine Google-Suche nötig.
      // Dateisystem wird durch die Remote-Environment automatisch aktiviert.
      tools: [
        {
          type: "code_execution",
        },
      ],

      // Wichtig: Agent läuft unabhängig von der Vercel-Anfrage weiter.
      background: true,
    });

    return res.status(202).json({
      ok: true,
      status: interaction.status,
      interaction_id: interaction.id,
      environment_id: interaction.environment_id ?? null,
      company_name: companyName,
    });
  } catch (error) {
    console.error("Antigravity start failed", error);

    return res.status(502).json({
      ok: false,
      error: "antigravity_start_failed",
      details:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}

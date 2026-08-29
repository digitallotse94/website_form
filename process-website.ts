import { GoogleGenAI } from "@google/genai";

type JsonRecord = Record<string, unknown>;

type BusinessInput = {
  company_name: string;
  industry: string;
  location: string;
  primary_goal: string;
  primary_goal_other: string;
  services: string;
  differentiators: string;
  preferred_cta: string;
  has_existing_website: "yes" | "no";
  existing_website: string;
};

export const maxDuration = 60;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";

export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const workflowSecret = process.env.WORKFLOW_SECRET || "";
  const providedSecret = String(req.headers["x-workflow-secret"] || "");

  if (!workflowSecret || workflowSecret !== providedSecret) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const geminiKey = process.env.GEMINI_API_KEY || "";
  if (!geminiKey) {
    return res.status(500).json({ ok: false, error: "gemini_key_missing" });
  }

  const payload = typeof req.body === "string"
    ? safeParseJson(req.body)
    : (req.body || {});

  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }

  const input = normalizeInput(payload as JsonRecord);

  if (!input.company_name) {
    return res.status(422).json({ ok: false, error: "company_name_required" });
  }

  let websiteText = "";
  let websiteSource = "none";

  if (input.has_existing_website === "yes" && input.existing_website) {
    const websiteResult = await fetchWebsiteText(input.existing_website);
    websiteText = websiteResult.text.slice(0, 28000);
    websiteSource = websiteResult.source;
  }

  const ai = new GoogleGenAI({ apiKey: geminiKey });

  let interaction: any;

  try {
    interaction = await ai.interactions.create({
      model: GEMINI_MODEL,
      input: buildPrompt(input, websiteText, websiteSource),
      generation_config: {
        thinking_level: "low"
      },
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: OUTPUT_SCHEMA
      }
    });
  } catch (error) {
    console.error("Gemini request failed", error);

    return res.status(502).json({
      ok: false,
      error: "gemini_request_failed",
      details: error instanceof Error ? error.message : String(error)
    });
  }

  const outputText =
    typeof interaction?.output_text === "string"
      ? interaction.output_text.trim()
      : "";

  if (!outputText) {
    return res.status(502).json({
      ok: false,
      error: "gemini_empty_output",
      status: interaction?.status ?? null
    });
  }

  let generated: {
    blueprint: JsonRecord;
    website_copy: JsonRecord;
  };

  try {
    generated = JSON.parse(outputText);
  } catch {
    return res.status(502).json({
      ok: false,
      error: "gemini_invalid_structured_output"
    });
  }

  if (!generated.blueprint || !generated.website_copy) {
    return res.status(502).json({
      ok: false,
      error: "gemini_missing_output_fields"
    });
  }

  const vibePrompt = buildV0Prompt(
    input.company_name,
    input.existing_website,
    generated.blueprint,
    generated.website_copy
  );

  return res.status(200).json({
    ok: true,
    blueprint: generated.blueprint,
    website_copy: generated.website_copy,
    vibe_prompt: vibePrompt,
    meta: {
      model: GEMINI_MODEL,
      website_source: websiteSource,
      website_text_characters: websiteText.length,
      usage: interaction?.usage ?? null
    }
  });
}

function safeParseJson(value: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeInput(payload: JsonRecord): BusinessInput {
  return {
    company_name: clean(payload.company_name),
    industry: clean(payload.industry),
    location: clean(payload.location),
    primary_goal: clean(payload.primary_goal),
    primary_goal_other: clean(payload.primary_goal_other),
    services: clean(payload.services),
    differentiators: clean(payload.differentiators),
    preferred_cta: Array.isArray(payload.preferred_cta)
      ? payload.preferred_cta.map(clean).filter(Boolean).join(", ")
      : clean(payload.preferred_cta),
    has_existing_website: normalizeYesNo(payload.has_existing_website),
    existing_website: normalizeUrl(clean(payload.existing_website))
  };
}

function clean(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(clean).filter(Boolean).join(", ");
  }

  return value == null ? "" : String(value).trim();
}

function normalizeYesNo(value: unknown): "yes" | "no" {
  const normalized = clean(value).toLowerCase();

  if (value === true || value === 1 || value === "1") {
    return "yes";
  }

  return ["yes", "ja", "true"].includes(normalized) ? "yes" : "no";
}

function normalizeUrl(value: string): string {
  if (!value) return "";

  const candidate = /^https?:\/\//i.test(value)
    ? value
    : `https://${value}`;

  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol)
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

async function fetchWebsiteText(
  url: string
): Promise<{ text: string; source: string }> {
  const jinaResponse = await timedFetch(
    `https://r.jina.ai/${url}`,
    18000,
    {
      headers: {
        Accept: "text/plain",
        "User-Agent": "WebsiteDemoProcessor/1.0"
      }
    }
  );

  if (jinaResponse?.ok) {
    const text = (await jinaResponse.text()).trim();

    if (text) {
      return {
        text,
        source: "jina_reader"
      };
    }
  }

  const directResponse = await timedFetch(
    url,
    14000,
    {
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; WebsiteDemoProcessor/1.0)"
      }
    }
  );

  if (directResponse?.ok) {
    const html = await directResponse.text();
    const text = htmlToReadableText(html);

    if (text) {
      return {
        text,
        source: "direct_html_fallback"
      };
    }
  }

  return {
    text: "",
    source: "fetch_failed"
  };
}

async function timedFetch(
  url: string,
  milliseconds: number,
  init: RequestInit = {}
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    milliseconds
  );

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function htmlToReadableText(html: string): string {
  return html
    .replace(
      /<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " "
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPrompt(
  data: BusinessInput,
  websiteText: string,
  websiteSource: string
): string {
  const existingWebsite =
    data.has_existing_website === "yes"
      ? data.existing_website || "URL fehlt oder ist ungültig"
      : "keine";

  return `Du bist gleichzeitig Website-Stratege und Senior-Webtexter für kleine und mittlere Unternehmen.

ZIEL
Erstelle in EINEM Durchgang:
1. ein belastbares Website-Blueprint,
2. die vollständigen Texte für eine kompakte, hochwertige Unternehmens-Visitenkarten-Website als Onepager.

GRUNDREGELN
- Erfinde niemals Fakten, Referenzen, Bewertungen, Mitarbeiterzahlen, Jahreszahlen, Zertifikate, Preise, Öffnungszeiten oder Leistungsversprechen.
- Informationen aus einer vorhandenen Website gelten als Quelle und haben Vorrang vor Vermutungen.
- Formularangaben haben ebenfalls hohe Priorität.
- Fehlende Informationen im Blueprint klar als fehlend kennzeichnen.
- In sichtbaren Website-Texten niemals "unbekannt" schreiben.
- Wenn eine zwingend benötigte Information fehlt, verwende sparsam einen klaren Platzhalter wie [ERGÄNZEN: Telefonnummer].
- Keine übertriebenen Superlative, keine leeren Marketingfloskeln und kein generischer KI-Ton.
- Inhalte sollen professionell, konkret, verständlich und zur Branche passend sein.
- Bestehende gute Formulierungen dürfen übernommen oder vorsichtig verbessert werden.
- Die Website ist bewusst eine fokussierte Unternehmens-Visitenkarte, kein komplexes Portal.

FORMULARDATEN
Unternehmen: ${data.company_name}
Branche: ${data.industry}
Standort: ${data.location}
Hauptziel: ${data.primary_goal}
Weiteres Ziel: ${data.primary_goal_other}
Leistungen: ${data.services}
Besonderheiten: ${data.differentiators}
Gewünschte Kontaktwege: ${data.preferred_cta}
Bestehende Website: ${existingWebsite}

AUSLESEQUELLE
${websiteSource}

INHALT DER BESTEHENDEN WEBSITE
${websiteText || "[Kein verwertbarer Website-Inhalt verfügbar]"}

BLUEPRINT
Ermittle:
- Branche und Unternehmenstyp
- Standort bzw. Tätigkeitsgebiet
- Zielgruppen
- Hauptziel der Website
- wichtigste Leistungen
- belegbare Vertrauensfaktoren
- primäre und sekundäre Call-to-Action
- passende Tonalität
- passende Designrichtung
- optimale Reihenfolge der Abschnitte
- bestehende Inhalte, die sinnvoll übernommen werden sollten
- fehlende Informationen

WEBSITE-TEXTE
Erstelle:
- SEO-Titel und Meta-Description
- Hero mit Eyebrow, Headline, Subheadline und CTAs
- alle im Blueprint vorgesehenen Inhaltsabschnitte
- konkrete Überschriften, Fließtexte und Listen/Kacheln
- Kontakt- bzw. Abschlusssektion
- Footer-Kurztext
- Bildbriefing je relevanter Sektion
- Liste tatsächlich noch benötigter Platzhalter

Die Ausgabe muss exakt dem vorgegebenen JSON-Schema entsprechen.`;
}

function buildV0Prompt(
  companyName: string,
  existingWebsite: string,
  blueprint: JsonRecord,
  websiteCopy: JsonRecord
): string {
  const sourceNote = existingWebsite
    ? `Bestehende Website als Informationsquelle: ${existingWebsite}`
    : "Keine bestehende Website vorhanden.";

  return `Erstelle eine professionelle, mobile-first Unternehmens-Visitenkarten-Website als Onepager für ${companyName}.

TECHNISCHER STACK
- React/TypeScript
- moderne komponentenbasierte Struktur
- vollständig responsive für Smartphone, Tablet und Desktop
- semantisches HTML
- keine unnötigen Abhängigkeiten

ZIEL
Baue ohne Rückfragen einen hochwertigen, individuellen Onepager auf Basis des folgenden Blueprints und der fertigen Website-Texte. Die Website soll zur Branche und Tonalität passen und nicht wie ein generisches Template wirken.

${sourceNote}

WICHTIGE REGELN
- Erfinde keine Fakten, Referenzen, Bewertungen, Kennzahlen, Zertifikate, Auszeichnungen, Mitarbeiter oder Projekte.
- Verwende die gelieferten Texte und Fakten.
- Kein Lorem ipsum.
- Wenn kein echtes Logo geliefert wurde, verwende den Unternehmensnamen als saubere Wortmarke. Kein Fantasielogo.
- Wenn keine belegten Markenfarben vorliegen, erfinde keine vermeintliche Corporate-Farbwelt. Nutze eine hochwertige neutrale Basis und zur Branche passende Akzente.
- Das Styling soll so strukturiert sein, dass echte Markenfarben später leicht ersetzt werden können.
- Bilder nur als glaubwürdige neutrale Branchenmotive oder klar erkennbare Platzhalter vorsehen.
- Keine angeblich echten Firmenprojekte oder Mitarbeiterbilder erfinden.
- Bildbereiche anhand des gelieferten Bildbriefings umsetzen.
- Keine Stockfoto-Überladung, unnötigen Slider oder übermäßigen Animationen.
- Dezente Hover- und Scroll-Effekte nur performant und zurückhaltend.
- Gute Kontraste, sichtbare Fokuszustände, Tastaturbedienbarkeit und sinnvolle Alt-Texte.
- Navigation als Anchor-Navigation; mobil als zugängliches Menü.
- Primären CTA im Hero und an mindestens einer weiteren passenden Stelle wiederholen.
- Kontaktbereich nur mit tatsächlich vorhandenen Kontaktwegen; markierte Platzhalter beibehalten.
- Footer mit Unternehmensname und Links zu Impressum und Datenschutz.
- Keine rechtlichen Inhalte erfinden.
- Keine Analytics-, Tracking- oder Cookie-Skripte.
- SEO-Titel und Meta-Description exakt aus den gelieferten Website-Texten übernehmen.
- Komponenten sinnvoll strukturieren, aber den Onepager nicht over-engineeren.
- Das Ergebnis soll direkt startbar und präsentationsfähig sein.

WEBSITE-BLUEPRINT
${JSON.stringify(blueprint, null, 2)}

FERTIGE WEBSITE-TEXTE
${JSON.stringify(websiteCopy, null, 2)}

Setze jetzt die vollständige Website um. Verwende die vorgegebene Abschnittsreihenfolge, Inhalte, CTAs und Bildbriefings.`;
}

const S = { type: "string" } as const;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["blueprint", "website_copy"],
  properties: {
    blueprint: {
      type: "object",
      additionalProperties: false,
      required: [
        "business",
        "strategy",
        "services",
        "trust_factors",
        "sections",
        "existing_content_to_keep",
        "missing_information"
      ],
      properties: {
        business: {
          type: "object",
          additionalProperties: false,
          required: [
            "industry",
            "business_type",
            "location",
            "target_groups"
          ],
          properties: {
            industry: S,
            business_type: S,
            location: S,
            target_groups: {
              type: "array",
              items: S
            }
          }
        },
        strategy: {
          type: "object",
          additionalProperties: false,
          required: [
            "primary_goal",
            "primary_cta",
            "secondary_cta",
            "tone",
            "design_direction"
          ],
          properties: {
            primary_goal: S,
            primary_cta: S,
            secondary_cta: S,
            tone: S,
            design_direction: S
          }
        },
        services: {
          type: "array",
          items: S
        },
        trust_factors: {
          type: "array",
          items: S
        },
        sections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "type",
              "purpose"
            ],
            properties: {
              type: S,
              purpose: S
            }
          }
        },
        existing_content_to_keep: {
          type: "array",
          items: S
        },
        missing_information: {
          type: "array",
          items: S
        }
      }
    },
    website_copy: {
      type: "object",
      additionalProperties: false,
      required: [
        "seo",
        "hero",
        "sections",
        "contact",
        "footer",
        "image_brief",
        "placeholders_needed"
      ],
      properties: {
        seo: {
          type: "object",
          additionalProperties: false,
          required: [
            "title",
            "meta_description"
          ],
          properties: {
            title: S,
            meta_description: S
          }
        },
        hero: {
          type: "object",
          additionalProperties: false,
          required: [
            "eyebrow",
            "headline",
            "subheadline",
            "primary_cta",
            "secondary_cta"
          ],
          properties: {
            eyebrow: S,
            headline: S,
            subheadline: S,
            primary_cta: S,
            secondary_cta: S
          }
        },
        sections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "type",
              "headline",
              "intro",
              "body",
              "items",
              "cta"
            ],
            properties: {
              type: S,
              headline: S,
              intro: S,
              body: S,
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "title",
                    "text"
                  ],
                  properties: {
                    title: S,
                    text: S
                  }
                }
              },
              cta: S
            }
          }
        },
        contact: {
          type: "object",
          additionalProperties: false,
          required: [
            "headline",
            "text",
            "cta"
          ],
          properties: {
            headline: S,
            text: S,
            cta: S
          }
        },
        footer: {
          type: "object",
          additionalProperties: false,
          required: [
            "short_text"
          ],
          properties: {
            short_text: S
          }
        },
        image_brief: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "section",
              "subject",
              "style",
              "avoid"
            ],
            properties: {
              section: S,
              subject: S,
              style: S,
              avoid: S
            }
          }
        },
        placeholders_needed: {
          type: "array",
          items: S
        }
      }
    }
  }
} as const;

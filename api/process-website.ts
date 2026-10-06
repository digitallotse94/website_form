import { GoogleGenAI, ThinkingLevel } from "@google/genai";

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

export const maxDuration = 80;

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GEMINI_FALLBACK_MODEL =
  process.env.GEMINI_FALLBACK_MODEL || "gemini-3.6-flash";
const GEMINI_REQUEST_TIMEOUT_MS = 45000;
const GEMINI_TOTAL_TIMEOUT_MS = 75000;

type GeminiGenerationResult = {
  response: any;
  model: string;
  attempts: number;
};

type DesignStyle = {
  id: string;
  key: string;
  name: string;
  group: "core" | "special";
  summary: string;
  selection_signals: string[];
  avoid_when: string[];
  [key: string]: unknown;
};

type TypographySet = {
  id: string;
  key: string;
  name: string;
  heading: JsonRecord;
  body: JsonRecord;
  implementation: JsonRecord;
  [key: string]: unknown;
};

type PaletteStyleApplication = {
  background_mode: string;
  brand_coverage: string;
  accent_count: number;
  notes: string;
};

type ImageProfile = {
  id: string;
  key: string;
  name: string;
  use_for: string[];
  keywords_en: string[];
  preferred_subjects: string[];
  mood: string[];
  hero_composition: string[];
  avoid: string[];
  [key: string]: unknown;
};

type HeroVariant = {
  id: string;
  name: string;
  best_for: string[];
  [key: string]: unknown;
};

type ContentPattern = {
  id: string;
  name: string;
  compatible_styles: string[];
  [key: string]: unknown;
};

type ContactVariant = {
  id: string;
  name: string;
  best_for: string[];
  [key: string]: unknown;
};

type ComponentSelection = {
  hero: HeroVariant;
  content: ContentPattern[];
  contact: ContactVariant;
};

const designCatalog = require("../config/builder/design-catalog.json") as {
  schema_version: string;
  catalog_id: string;
  selection_logic: {
    fallback_style_id: string;
    core_style_rule: string;
    special_style_rule: string;
  };
  styles: DesignStyle[];
};

const typographyCatalog = require("../config/builder/typography-catalog.json") as {
  schema_version: string;
  catalog_id: string;
  selection_logic: {
    fallback_set_id: string;
  };
  sets: TypographySet[];
  style_defaults: Record<string, string>;
};

const paletteRules = require("../config/builder/palette-rules.json") as {
  schema_version: string;
  catalog_id: string;
  principle: string;
  input_priority: string[];
  output_tokens: string[];
  generation_rules: JsonRecord;
  accessibility: JsonRecord;
  style_application: Record<string, PaletteStyleApplication>;
  neutral_presets: JsonRecord;
  fallback_brand_palettes: JsonRecord[];
  prohibited: string[];
};

const imageProfileCatalog = require("../config/builder/image-profile-catalog.json") as {
  schema_version: string;
  catalog_id: string;
  purpose: string;
  selection_logic: {
    fallback_profile_id: string;
    rule: string;
  };
  global_rules: JsonRecord;
  profiles: ImageProfile[];
  style_affinities: Record<string, string[]>;
};

const componentCatalog = require("../config/builder/component-catalog.json") as {
  schema_version: string;
  catalog_id: string;
  purpose: string;
  global_rules: JsonRecord;
  hero_variants: HeroVariant[];
  content_patterns: ContentPattern[];
  contact_variants: ContactVariant[];
  assembly_rules: JsonRecord;
  style_defaults: Record<
    string,
    { hero: string; content: string[]; contact: string }
  >;
};

const DESIGN_STYLE_SUMMARY = designCatalog.styles.map((style) => ({
  id: style.id,
  name: style.name,
  group: style.group,
  summary: style.summary,
  selection_signals: style.selection_signals,
  avoid_when: style.avoid_when
}));

const IMAGE_PROFILE_SUMMARY = imageProfileCatalog.profiles.map((profile) => ({
  id: profile.id,
  name: profile.name,
  use_for: profile.use_for,
  preferred_subjects: profile.preferred_subjects,
  mood: profile.mood,
  avoid: profile.avoid
}));

const COMPONENT_CATALOG_SUMMARY = {
  hero_variants: componentCatalog.hero_variants,
  content_patterns: componentCatalog.content_patterns,
  contact_variants: componentCatalog.contact_variants,
  assembly_rules: componentCatalog.assembly_rules,
  style_defaults: componentCatalog.style_defaults
};

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

  let generationResult: GeminiGenerationResult;

  try {
    generationResult = await generateWithRetryAndFallback(
      ai,
      buildPrompt(input, websiteText, websiteSource)
    );
  } catch (error) {
    console.error("Gemini request failed after retries and fallback", error);

    return res.status(502).json({
      ok: false,
      error: isTimeoutError(error)
        ? "gemini_timeout"
        : "gemini_request_failed",
      details: error instanceof Error ? error.message : String(error)
    });
  }

  const { response, model: usedModel, attempts } = generationResult;

const outputText =
  typeof response?.text === "string"
    ? response.text.trim()
    : "";

if (!outputText) {
  return res.status(502).json({
    ok: false,
    error: "gemini_empty_output"
  });
}

let generated: {
  blueprint: JsonRecord;
  website_copy: JsonRecord;
};

try {
  generated = JSON.parse(outputText);
} catch (error) {
  console.error("Gemini JSON parsing failed", error);

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

  const selectedDesignStyle = resolveDesignStyle(generated.blueprint);
  const selectedTypography = resolveTypographySet(selectedDesignStyle.id);
  const selectedPaletteGuidance = resolvePaletteGuidance(selectedDesignStyle.id);
  const selectedImageProfile = resolveImageProfile(
    generated.blueprint,
    selectedDesignStyle.id
  );
  const selectedComponents = resolveComponentSelection(
    generated.blueprint,
    selectedDesignStyle.id
  );

  const vibePrompt = buildV0Prompt(
    input,
    generated.blueprint,
    generated.website_copy,
    selectedDesignStyle,
    selectedTypography,
    selectedPaletteGuidance,
    selectedImageProfile,
    selectedComponents
  );

  return res.status(200).json({
    ok: true,
    blueprint: generated.blueprint,
    website_copy: generated.website_copy,
    vibe_prompt: vibePrompt,
    design_system: {
      style_id: selectedDesignStyle.id,
      style_name: selectedDesignStyle.name,
      typography_id: selectedTypography.id,
      typography_name: selectedTypography.name,
      palette_mode: selectedPaletteGuidance.style_application.background_mode,
      palette_brand_coverage:
        selectedPaletteGuidance.style_application.brand_coverage,
      image_profile_id: selectedImageProfile.id,
      image_profile_name: selectedImageProfile.name,
      hero_variant_id: selectedComponents.hero.id,
      hero_variant_name: selectedComponents.hero.name,
      content_pattern_ids: selectedComponents.content.map((item) => item.id),
      content_pattern_names: selectedComponents.content.map((item) => item.name),
      contact_variant_id: selectedComponents.contact.id,
      contact_variant_name: selectedComponents.contact.name,
      catalog_id: designCatalog.catalog_id,
      catalog_version: designCatalog.schema_version,
      typography_catalog_id: typographyCatalog.catalog_id,
      typography_catalog_version: typographyCatalog.schema_version,
      palette_catalog_id: paletteRules.catalog_id,
      palette_catalog_version: paletteRules.schema_version,
      image_catalog_id: imageProfileCatalog.catalog_id,
      image_catalog_version: imageProfileCatalog.schema_version,
      component_catalog_id: componentCatalog.catalog_id,
      component_catalog_version: componentCatalog.schema_version
    },
    meta: {
      model: usedModel,
      attempts,
      fallback_used: usedModel !== GEMINI_MODEL,
      website_source: websiteSource,
      website_text_characters: websiteText.length,
      usage: response?.usageMetadata ?? null
    }
  });
}

async function generateWithRetryAndFallback(
  ai: GoogleGenAI,
  prompt: string
): Promise<GeminiGenerationResult> {
  const attemptPlan = [
    { model: GEMINI_MODEL, delayMs: 0 },
    { model: GEMINI_MODEL, delayMs: 2500 },
    { model: GEMINI_FALLBACK_MODEL, delayMs: 6000 }
  ].filter(
    (attempt, index, attempts) =>
      index < 2 || attempt.model !== attempts[0].model
  );
  const deadline = Date.now() + GEMINI_TOTAL_TIMEOUT_MS;
  let lastError: unknown;

  for (let index = 0; index < attemptPlan.length; index += 1) {
    const attempt = attemptPlan[index];

    if (attempt.delayMs > 0) {
      await sleep(attempt.delayMs);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs < 5000) break;

    const timeoutMs = Math.min(GEMINI_REQUEST_TIMEOUT_MS, remainingMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await ai.models.generateContent({
        model: attempt.model,
        contents: prompt,
        config: {
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW
          },
          responseMimeType: "application/json",
          responseSchema: OUTPUT_SCHEMA,
          maxOutputTokens: 8192,
          temperature: 0.3,
          abortSignal: controller.signal,
          httpOptions: {
            timeout: timeoutMs
          }
        }
      });

      return {
        response,
        model: attempt.model,
        attempts: index + 1
      };
    } catch (error) {
      lastError = error;
      console.warn(
        `Gemini attempt ${index + 1} with ${attempt.model} failed`,
        error
      );

      if (!isTransientGeminiError(error)) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("gemini_retry_budget_exhausted");
}

function isTransientGeminiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return /(429|500|502|503|504|RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|timeout|aborted|ECONNRESET|ETIMEDOUT)/i.test(
    message
  );
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(timeout|aborted|ETIMEDOUT)/i.test(message);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
- Die direkten Formularangaben sind die verbindliche Hauptquelle und haben immer Vorrang.
- Eine vorhandene Website darf als ergänzende Quelle für Leistungen, bestehende Texte und das Markendesign verwendet werden. Sie kann jedoch veraltete Inhalte enthalten.
- Veränderliche Angaben wie Personen, Geschäftsführung, Team, Zuständigkeiten, Kontaktdaten, Preise und Öffnungszeiten dürfen nur übernommen werden, wenn sie direkt im Formular bestätigt wurden.
- Erstelle keine Teamsektion und nenne keine Personen, wenn dafür keine bestätigten Formulardaten vorliegen.
- Bei widersprüchlichen oder möglicherweise veralteten Angaben darfst du keine Entscheidung durch Vermutung treffen. Lasse den Inhalt weg oder kennzeichne ihn unter fehlende Informationen.
- Fehlende Informationen im Blueprint klar als fehlend kennzeichnen.
- In sichtbaren Website-Texten niemals "unbekannt" schreiben.
- Wenn eine zwingend benötigte Information fehlt, verwende sparsam einen klaren Platzhalter wie [ERGÄNZEN: Telefonnummer].
- Keine übertriebenen Superlative, keine leeren Marketingfloskeln und kein generischer KI-Ton.
- Inhalte sollen professionell, konkret, verständlich und zur Branche passend sein.
- Bestehende gute Formulierungen dürfen übernommen oder vorsichtig verbessert werden.
- Die Website ist bewusst eine fokussierte Unternehmens-Visitenkarte, kein komplexes Portal.
- Konzipiere eine ruhige, moderne Unternehmenswebsite und keine verkaufsorientierte
  Landingpage, keinen digitalen Flyer und keine Aneinanderreihung von Werbebannern.
- Plane nur Abschnitte, die eine konkrete Informations- oder Kontaktfunktion erfüllen.
- Plane keine Stichwortbanner, Logo-Leisten, Zahlenbänder, Badge-Sammlungen oder
  dekorativen Rechteckflächen ohne eigenständigen inhaltlichen Nutzen.
- Nutze Weißraum, Typografie, wenige passende Bilder und eine klare Leserichtung
  statt viele Kästen, Kacheln und farbige Flächen vorzuschlagen.

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

DESIGN-STIL-KATALOG
Wähle genau einen Design-Stil aus dem folgenden Katalog. Kern-Styles sind der
Standard. Spezial-Styles dürfen nur gewählt werden, wenn der Betrieb ausdrücklich
eine solche Richtung erkennen lässt oder mindestens drei starke Auswahlsignale
erfüllt und kein Ausschlusskriterium zutrifft.

Katalogregeln:
- ${designCatalog.selection_logic.core_style_rule}
- ${designCatalog.selection_logic.special_style_rule}
- Fallback bei unklarer Datenlage: ${designCatalog.selection_logic.fallback_style_id}

Verfügbare Styles:
${JSON.stringify(DESIGN_STYLE_SUMMARY, null, 2)}

BILDPROFIL-KATALOG
Wähle genau ein Bildprofil anhand der realen Tätigkeit, des Angebots und der
benötigten Motive. Die reine Branchenbezeichnung reicht nicht aus. Berücksichtige
den gewählten Design-Stil, aber bevorzuge ein fachlich passendes Motivprofil.

Katalogregel:
- ${imageProfileCatalog.selection_logic.rule}
- Fallback bei unklarer Datenlage: ${imageProfileCatalog.selection_logic.fallback_profile_id}

Verfügbare Bildprofile:
${JSON.stringify(IMAGE_PROFILE_SUMMARY, null, 2)}

KOMPONENTEN-KATALOG
Wähle eine Hero-Variante, ein bis drei Inhaltsmuster und eine Kontaktvariante.
Alle gewählten Komponenten müssen mit der design_style_id kompatibel sein und
eine konkrete inhaltliche Aufgabe erfüllen. Verwende die Style-Standards als
Fallback, aber weiche davon ab, wenn Unternehmensdaten und Inhalte eine passendere
kompatible Variante begründen. Füge keine Komponente nur zur Dekoration hinzu.

${JSON.stringify(COMPONENT_CATALOG_SUMMARY, null, 2)}

BLUEPRINT
Ermittle:
- Branche und Unternehmenstyp
- Standort bzw. Tätigkeitsgebiet
- Zielgruppen
- Hauptziel der Website
- wichtigste Leistungen
- belegbare Vertrauensfaktoren
- genau eine primäre Call-to-Action; eine sekundäre Aktion nur bei einem klar
  abweichenden und tatsächlich benötigten Ziel
- passende Tonalität
- passende, bewusst reduzierte Designrichtung im Stil einer hochwertigen
  Unternehmens-Visitenkarte
- genau eine design_style_id aus dem Design-Stil-Katalog und eine kurze,
  nachvollziehbare design_style_reason
- genau eine image_profile_id aus dem Bildprofil-Katalog und eine kurze,
  nachvollziehbare image_profile_reason
- genau eine hero_variant_id, ein bis drei content_pattern_ids und genau eine
  contact_variant_id aus dem Komponenten-Katalog sowie eine kurze component_reason
- Markenfarben der bestehenden Website sowie geeignete neutrale Hintergrundfarben
- ein branchenspezifisches Hero-Bildkonzept mit Fokus auf Materialien, Produkte,
  Werkzeuge oder charakteristische Arbeitsdetails
- optimale Reihenfolge der Abschnitte
- eine SEO-sinnvolle H1-H2-H3-Struktur ohne Keyword-Stuffing
- bestehende Inhalte, die sinnvoll übernommen werden sollten
- fehlende Informationen

WEBSITE-TEXTE
Erstelle:
- SEO-Titel und Meta-Description
- Hero mit einer klaren H1, kurzer Subheadline und genau einem primären CTA;
  eine Eyebrow nur, wenn sie eine echte Zusatzinformation enthält
- alle im Blueprint vorgesehenen Inhaltsabschnitte
- konkrete suchorientierte H2- und bei Bedarf H3-Überschriften, Fließtexte und
  sparsame Listen; Kacheln nur bei wirklich voneinander abgrenzbaren Inhalten
- Kontakt- bzw. Abschlusssektion
- Footer-Kurztext
- Bildbriefing je relevanter Sektion
- Liste tatsächlich noch benötigter Platzhalter

WICHTIG ZU DEN AUSGABEFELDERN
- Die technisch vorhandenen Felder secondary_cta, eyebrow und sections[].cta
  müssen als leere Zeichenkette ausgegeben werden, wenn kein eigenständiger
  inhaltlicher Bedarf besteht.
- Fülle diese Felder nicht nur deshalb, weil sie im Schema vorhanden sind.
- Insbesondere erhalten normale Inhaltsabschnitte grundsätzlich keinen eigenen CTA.

Die Ausgabe muss exakt dem vorgegebenen JSON-Schema entsprechen.`;
}

function resolveDesignStyle(blueprint: JsonRecord): DesignStyle {
  const strategy =
    blueprint.strategy && typeof blueprint.strategy === "object"
      ? (blueprint.strategy as JsonRecord)
      : {};

  const requestedId = clean(strategy.design_style_id).toUpperCase();
  const fallbackId = designCatalog.selection_logic.fallback_style_id || "D01";
  const selected =
    designCatalog.styles.find((style) => style.id === requestedId) ||
    designCatalog.styles.find((style) => style.id === fallbackId) ||
    designCatalog.styles[0];

  if (!selected) {
    throw new Error("design_catalog_empty");
  }

  return selected;
}

function resolveTypographySet(styleId: string): TypographySet {
  const requestedId = typographyCatalog.style_defaults[styleId];
  const fallbackId = typographyCatalog.selection_logic.fallback_set_id || "T01";
  const selected =
    typographyCatalog.sets.find((set) => set.id === requestedId) ||
    typographyCatalog.sets.find((set) => set.id === fallbackId) ||
    typographyCatalog.sets[0];

  if (!selected) {
    throw new Error("typography_catalog_empty");
  }

  return selected;
}

function resolvePaletteGuidance(styleId: string): JsonRecord & {
  style_application: PaletteStyleApplication;
} {
  const styleApplication = paletteRules.style_application[styleId];

  if (!styleApplication) {
    throw new Error(`palette_style_missing_${styleId}`);
  }

  return {
    principle: paletteRules.principle,
    input_priority: paletteRules.input_priority,
    output_tokens: paletteRules.output_tokens,
    generation_rules: paletteRules.generation_rules,
    accessibility: paletteRules.accessibility,
    style_application: styleApplication,
    neutral_presets: paletteRules.neutral_presets,
    fallback_brand_palettes: paletteRules.fallback_brand_palettes,
    prohibited: paletteRules.prohibited
  };
}

function resolveImageProfile(
  blueprint: JsonRecord,
  styleId: string
): ImageProfile {
  const strategy =
    blueprint.strategy && typeof blueprint.strategy === "object"
      ? (blueprint.strategy as JsonRecord)
      : {};
  const requestedId = clean(strategy.image_profile_id).toUpperCase();
  const fallbackId =
    imageProfileCatalog.selection_logic.fallback_profile_id || "I01";
  const styleAffinityIds = imageProfileCatalog.style_affinities[styleId] || [];
  const selected =
    imageProfileCatalog.profiles.find((profile) => profile.id === requestedId) ||
    imageProfileCatalog.profiles.find(
      (profile) => profile.id === styleAffinityIds[0]
    ) ||
    imageProfileCatalog.profiles.find((profile) => profile.id === fallbackId) ||
    imageProfileCatalog.profiles[0];

  if (!selected) {
    throw new Error("image_profile_catalog_empty");
  }

  return selected;
}

function resolveComponentSelection(
  blueprint: JsonRecord,
  styleId: string
): ComponentSelection {
  const strategy =
    blueprint.strategy && typeof blueprint.strategy === "object"
      ? (blueprint.strategy as JsonRecord)
      : {};
  const defaults = componentCatalog.style_defaults[styleId];

  if (!defaults) {
    throw new Error(`component_defaults_missing_${styleId}`);
  }

  const requestedHeroId = clean(strategy.hero_variant_id).toUpperCase();
  const hero =
    componentCatalog.hero_variants.find(
      (item) => item.id === requestedHeroId && item.best_for.includes(styleId)
    ) ||
    componentCatalog.hero_variants.find((item) => item.id === defaults.hero);

  const requestedContentIds = Array.isArray(strategy.content_pattern_ids)
    ? strategy.content_pattern_ids.map(clean).map((id) => id.toUpperCase())
    : [];
  const compatibleRequestedContent = requestedContentIds
    .map((id) => componentCatalog.content_patterns.find((item) => item.id === id))
    .filter(
      (item): item is ContentPattern =>
        Boolean(item && item.compatible_styles.includes(styleId))
    )
    .slice(0, 3);
  const content = compatibleRequestedContent.length
    ? compatibleRequestedContent
    : defaults.content
        .map((id) =>
          componentCatalog.content_patterns.find((item) => item.id === id)
        )
        .filter((item): item is ContentPattern => Boolean(item));

  const requestedContactId = clean(strategy.contact_variant_id).toUpperCase();
  const contact =
    componentCatalog.contact_variants.find(
      (item) =>
        item.id === requestedContactId && item.best_for.includes(styleId)
    ) ||
    componentCatalog.contact_variants.find(
      (item) => item.id === defaults.contact
    );

  if (!hero || !content.length || !contact) {
    throw new Error(`component_catalog_incomplete_${styleId}`);
  }

  return { hero, content, contact };
}

function buildV0Prompt(
  data: BusinessInput,
  blueprint: JsonRecord,
  websiteCopy: JsonRecord,
  selectedDesignStyle: DesignStyle,
  selectedTypography: TypographySet,
  selectedPaletteGuidance: JsonRecord,
  selectedImageProfile: ImageProfile,
  selectedComponents: ComponentSelection
): string {
  const sourceNote = data.existing_website
    ? data.existing_website
    : "Keine bestehende Website vorhanden.";

  const directFormData = {
    company_name: data.company_name,
    industry: data.industry,
    location: data.location,
    primary_goal: data.primary_goal,
    primary_goal_other: data.primary_goal_other,
    services: data.services,
    differentiators: data.differentiators,
    preferred_cta: data.preferred_cta,
    has_existing_website: data.has_existing_website,
    existing_website: data.existing_website
  };

  return `Du bist Senior-Webdesigner:in, UX-Spezialist:in und erfahrene:r React-Entwickler:in. Erstelle einen hochwertigen, präsentationsfähigen Onepager für ${data.company_name}.

AUFTRAG
Entwickle eine individuelle Unternehmenswebsite, die innerhalb weniger Sekunden vermittelt:
1. Was bietet der Betrieb an?
2. Für wen und in welcher Region?
3. Was unterscheidet ihn von anderen?
4. Welche Handlung sollen Besucher:innen als Nächstes ausführen?

Die Website darf nicht wie ein generisches KI-, SaaS- oder Baukasten-Template wirken. Gestaltung, Bildsprache, Seitenaufbau und Tonalität müssen erkennbar zum konkreten Unternehmen und seiner Branche passen.

Arbeite ohne Rückfragen. Wenn Informationen fehlen, reduziere den Inhalt sinnvoll oder verwende ausdrücklich gekennzeichnete Platzhalter.

TECHNISCHER STACK
- React und TypeScript
- mobile-first und vollständig responsiv
- optimiert für Smartphone, Tablet und Desktop
- semantisches HTML
- klare, wartbare Komponentenstruktur
- zentrale CSS-Variablen für Farben, Abstände und Typografie
- keine unnötigen Abhängigkeiten
- keine Analytics-, Tracking- oder Cookie-Skripte
- nur die unten ausgewählten Google Fonts über next/font/google laden
- performante und barrierearme Umsetzung
- direkt startbar und ohne Build-Fehler

PRIORITÄT DER INFORMATIONEN
Verwende Informationen in dieser Reihenfolge:
1. DIREKTE FORMULARDATEN: Diese Angaben wurden vom Unternehmen übermittelt und sind verbindlich.
2. WEBSITE-BLUEPRINT: Er dient als strategische Empfehlung für Aufbau, Ziel und Inhalte.
3. VORBEREITETE WEBSITE-TEXTE: Nutze sie als redaktionelle Grundlage. Du darfst sie für Layout und Verständlichkeit geringfügig kürzen, aber keine neuen Tatsachenbehauptungen ergänzen.
4. BESTEHENDE WEBSITE: Sie dient als wichtige Quelle für das vorhandene Markendesign, ist aber keine verlässliche Quelle für veränderliche Unternehmensangaben.

Bei Widersprüchen haben die direkten Formulardaten immer Vorrang.

VERBINDLICHER DESIGN-STIL AUS DEM KATALOG
Setze den folgenden Stil konsequent um. Er steuert Layout, Typografie-Charakter,
Bildwirkung, Flächen, Abstände und Komponentenwahl. Vorhandene Markenfarben,
Logo-Regeln, Barrierefreiheit und die tatsächlichen Unternehmensinhalte haben bei
einem Konflikt Vorrang. Erfinde keine neue Markenidentität.

${JSON.stringify(selectedDesignStyle, null, 2)}

VERBINDLICHES TYPOGRAFIE-SET AUS DEM KATALOG
Verwende exakt die folgenden Schriftfamilien, Schriftschnitte, Fallbacks und
Implementierungswerte. Lade keine weiteren Schriftfamilien und ersetze die
Auswahl nicht eigenmächtig. Die Überschriftenschrift ist nur für Überschriften
und kurze Hervorhebungen vorgesehen; längere Texte verwenden die Body-Schrift.

${JSON.stringify(selectedTypography, null, 2)}

VERBINDLICHE FARBREGELN AUS DEM KATALOG
Wende die folgenden Regeln in ihrer Priorität an. Bestehende und eindeutig
erkennbare Unternehmensfarben haben Vorrang. Der Design-Stil bestimmt deren
Flächenanteil und Anwendung, nicht die Branche. Wenn keine belastbare Markenfarbe
ermittelt werden kann, wähle genau eine passende Fallback-Palette aus der
übergebenen Liste und dokumentiere sie im Code über zentrale CSS-Variablen.
Erfinde keine zusätzliche prominente Farbe. Prüfe alle Text-, Button- und
Fokuskontraste nach den enthaltenen Barrierefreiheitsregeln.

${JSON.stringify(selectedPaletteGuidance, null, 2)}

VERBINDLICHES BILDPROFIL AUS DEM KATALOG
Nutze dieses Profil für Hero und Inhaltsbilder. Motive müssen zur realen
Tätigkeit passen. Beachte besonders die bevorzugten Motive, Bildstimmung,
Hero-Komposition und Ausschlussmotive. Die englischen Keywords sind die
Grundlage einer Stockbildsuche, aber kein Auftrag, beliebige Treffer ungeprüft
zu übernehmen. Eigene geeignete Unternehmensbilder haben weiterhin Vorrang.

${JSON.stringify(selectedImageProfile, null, 2)}

VERBINDLICHE KOMPONENTENAUSWAHL AUS DEM KATALOG
Setze diese Hero-, Inhalts- und Kontaktvarianten als strukturelle Grundlage um.
Die Inhaltsreihenfolge darf an die tatsächlichen Inhalte angepasst werden, aber
ersetze die gewählten Varianten nicht durch generische Kartenwände, Banner oder
zusätzliche Komponenten. Lasse ein Inhaltsmuster weg, wenn dafür keine belegbaren
Inhalte vorhanden sind.

${JSON.stringify(selectedComponents, null, 2)}

Leere Felder aus Blueprint oder Website-Texten bedeuten: Das entsprechende
Element soll nicht gerendert werden. Erzeuge niemals vorsorglich eine Eyebrow,
einen sekundären CTA, einen Abschnitts-CTA, ein Banner oder eine Karte, nur weil
das Datenmodell ein entsprechendes Feld enthält.

UMGANG MIT FAKTEN
- Erfinde keine Personen, Funktionen, Referenzen, Projekte, Bewertungen, Kundenstimmen, Kennzahlen, Preise, Auszeichnungen, Zertifikate, Mitgliedschaften, Öffnungszeiten, Adressen, Kontaktdaten oder Unternehmensgeschichte.
- Veränderliche Angaben wie Geschäftsführung, Team, Telefonnummern, E-Mail-Adressen, Preise und Öffnungszeiten dürfen nur verwendet werden, wenn sie in den direkten Formulardaten ausdrücklich genannt wurden.
- Informationen von einer bestehenden Website oder aus einer Websuche dürfen hierfür nicht ungeprüft übernommen werden.
- Fehlt eine verlässliche Angabe, lasse sie weg oder verwende einen eindeutig sichtbaren Platzhalter wie [Telefonnummer ergänzen].
- Erstelle keine Teamsektion, wenn keine bestätigten Personen geliefert wurden.

BESTEHENDES MARKENDESIGN ÜBERNEHMEN
Wenn eine bestehende Unternehmenswebsite angegeben wurde, untersuche sie vor der Gestaltung gezielt auf:
- das vorhandene Unternehmenslogo,
- primäre und ergänzende Markenfarben,
- typische Hintergrundfarben,
- Schriftwirkung und typografische Hierarchie,
- wiederkehrende Formen, Linien und Gestaltungselemente,
- Bildsprache sowie den Stil von Schaltflächen und Navigation.

Wenn eine erkennbare Markenidentität vorhanden ist, übertrage sie in ein moderneres und klareres Webdesign. Die neue Website soll weiterhin eindeutig zum Unternehmen gehören und nicht wie eine vollständig andere Marke wirken.

LOGO
Wenn auf der offiziellen bestehenden Unternehmenswebsite ein eindeutig zuordenbares Firmenlogo öffentlich zugänglich ist:
- übernimm dieses Logo in das Projekt,
- speichere es als lokales Projekt-Asset,
- verwende keine instabile externe Verlinkung,
- bewahre Seitenverhältnis und Proportionen,
- verzerre, beschneide oder verfärbe es nicht,
- bevorzuge eine hochauflösende SVG-, PNG- oder WebP-Version.

Das Logo muss auf jedem verwendeten Hintergrund klar erkennbar bleiben. Prüfe
dabei auch enthaltene Schriftzüge und feine Logoelemente. Setze ein dunkles Logo
nicht auf einen dunklen und ein helles Logo nicht auf einen hellen oder nahezu
gleichfarbigen Hintergrund. Wähle in diesem Fall eine ruhige neutrale Headerfläche
oder eine nachweislich vorhandene helle beziehungsweise dunkle Logovariante.
Verfärbe das Logo nicht eigenmächtig und erfinde keine alternative Logovariante.

Verwende keine Logos aus Branchenverzeichnissen, Suchergebnissen oder fremden Plattformen. Wenn das Logo nicht zuverlässig übernommen werden kann, verwende den Unternehmensnamen als zurückhaltende typografische Wortmarke. Erfinde kein neues Logo.

FARBEN
Leite die Farbpalette bevorzugt aus dem vorhandenen Logo und den wiederkehrenden Gestaltungselementen der bestehenden Website ab. Unterscheide echte Markenfarben von zufälligen Farben aus Fotos, Werbebannern, Cookie-Fenstern, Drittanbieter-Elementen oder Social-Media-Inhalten.

Reduziere die Farbpalette auf:
- eine dominante Markenfarbe,
- höchstens eine ergänzende Akzentfarbe,
- gut abgestimmte neutrale Hintergrund- und Textfarben.

Entwickle daraus eine moderne, barrierearme Farbpalette mit ausreichenden Kontrasten. Wenn keine erkennbare Markenidentität vorhanden ist, verwende eine hochwertige neutrale Basis und einen zur Branche passenden Akzent. Verwende nicht automatisch ein blaues Standarddesign.

Hintergrund- und Sekundärfarben müssen sichtbar mit den Unternehmensfarben
harmonieren. Leite helle und dunkle Flächen aus neutralen Tönen oder sehr
zurückhaltenden Abstufungen der tatsächlichen Markenfarben ab. Führe keine neue,
stark gesättigte Sekundärfarbe nur für optische Abwechslung ein. Nutze die
Markenfarbe gezielt für wenige Akzente, Links und den primären CTA statt für viele
große konkurrierende Flächen.

GESTALTUNGSAUFGABE
Leite aus Branche, Leistungen, Zielgruppe, Standort, Alleinstellungsmerkmalen und bestehendem Markendesign ein eigenständiges visuelles Konzept ab. Entscheide dich intern für eine klare Gestaltungsrichtung und setze sie konsequent um.

Definiere:
- eine erkennbare visuelle Leitidee,
- eine zum Unternehmen passende Farbwelt,
- eine klare Schrift- und Größenhierarchie,
- einen konsistenten Umgang mit Flächen, Linien, Bildern und Abständen,
- eine nachvollziehbare CTA-Hierarchie,
- einen abwechslungsreichen, aber ruhigen Seitenrhythmus.

VERBINDLICHE GESTALTUNGSRICHTUNG: VISITENKARTE STATT FLYER
Das Ergebnis soll wie eine hochwertige, aufgeräumte Unternehmens-Visitenkarte im
Web wirken: glaubwürdig, informativ, ruhig und langlebig. Es soll nicht wie eine
aggressive Vertriebs-Landingpage, ein Prospekt oder ein Social-Media-Carousel
wirken.

Deshalb gilt verbindlich:
- Keine zusätzlichen Banner oder farbigen Querstreifen, die nur Schlagworte,
  Einzelbegriffe oder bereits genannte Aussagen wiederholen.
- Keine dekorativen Rechtecke, Karten oder Rahmen ohne klare inhaltliche Funktion.
- Keine Badge-Wolken, Trust-Bars, Zahlenbänder oder Icon-Reihen ohne belegbare und
  für die Entscheidung relevante Inhalte.
- Nicht jede Aussage hervorheben. Die visuelle Hierarchie entsteht vor allem aus
  Typografie, Weißraum, Bildgrößen und wenigen gezielten Farbakzenten.
- Möglichst wenige unterschiedliche Oberflächenstile verwenden. Nicht zwischen
  jedem Abschnitt die Hintergrundfarbe wechseln.
- Lieber einen Abschnitt weglassen oder Inhalte zusammenführen, als die Seite mit
  schwachen Zusatzmodulen zu füllen.

RUHIGES UND ÜBERSICHTLICHES LAYOUT
Die Website soll großzügig, klar und leicht erfassbar wirken. Versuche nicht, möglichst viele Inhalte gleichzeitig sichtbar zu machen.

Beachte verbindlich:
- Inhalte nicht in zu kleine Spalten oder Karten pressen.
- Keine überlappenden Text-, Bild- oder Dekorationselemente.
- Keine verschachtelten Karten innerhalb anderer Karten.
- Auf Desktop höchstens drei inhaltliche Karten nebeneinander.
- Auf Tablets höchstens zwei Karten nebeneinander.
- Auf Smartphones alle umfangreichen Inhalte untereinander darstellen.
- Eine Karte oder Spalte sollte in der Regel mindestens 280 Pixel breit sein.
- Zwischen nebeneinanderstehenden Elementen ausreichend Abstand lassen.
- Bei längeren Texten großzügige einspaltige Layouts bevorzugen.
- Bild und Text nur dann nebeneinanderstellen, wenn beide ausreichend Platz erhalten.
- Textzeilen auf eine gut lesbare Länge begrenzen.
- Absätze kurz halten und umfangreiche Inhalte sinnvoll kürzen oder aufteilen.
- Pro Abschnitt nur eine zentrale Botschaft vermitteln.
- Nicht jeden gelieferten Inhalt in eine eigene sichtbare Box setzen.
- Zwischen den Hauptabschnitten ausreichend Weißraum einsetzen.
- Im Hero grundsätzlich nur einen klaren primären CTA als Button zeigen. Eine
  zweite Aktion ist nur zulässig, wenn sie ein anderes notwendiges Ziel hat; sie
  muss dann als zurückhaltender Textlink erscheinen und darf nicht direkt als
  zweiter gleichwertiger Button danebenstehen.
- Auf kleinen Bildschirmen keine Desktop-Anordnung künstlich beibehalten.

Wenn Inhalte nicht sinnvoll nebeneinander passen, ordne sie untereinander an. Übersichtlichkeit hat Vorrang vor einer besonders kompakten Seitendarstellung.

Der Onepager sollte in der Regel aus fünf bis sieben klar unterscheidbaren Hauptabschnitten bestehen. Fasse verwandte Inhalte zusammen, anstatt für jeden Datenpunkt eine neue Sektion zu erstellen.

BRANCHENSPEZIFISCHER HERO
Nutze nach Möglichkeit ein prägnantes, branchenspezifisches Hero-Motiv. Bevorzuge
Materialien, Produkte, Werkzeuge, Oberflächen, Arbeitsdetails oder ein glaubwürdiges
Arbeitsergebnis der jeweiligen Branche. Das Motiv soll die Leistung atmosphärisch
erkennbar machen, ohne ein konkretes nicht belegtes Referenzprojekt vorzutäuschen.
Vermeide generische Händedruck-, Büro-, Skyline-, KI- und austauschbare
Stockfoto-Motive. Text auf dem Hero-Bild benötigt eine ruhige Fläche oder eine
dezente Kontrastüberlagerung und muss klar lesbar bleiben. Wenn kein passendes Bild
zuverlässig verfügbar ist, verwende einen konkreten Bildplatzhalter statt eines
beliebigen Ersatzmotivs.

VERMEIDE TYPISCHE KI-TEMPLATES
Vermeide insbesondere:
- austauschbare SaaS-Optik,
- Farbverläufe ohne Markenbezug,
- dekorative Blobs und zufällige geometrische Formen,
- übermäßig abgerundete oder verschachtelte Karten,
- überall schwebende Boxen,
- große Mengen identischer Karten,
- nichtssagende Icons in farbigen Kreisen,
- übertriebene Schatten,
- beliebige Stockfoto-Motive,
- unnötige Slider,
- erfundene Statistiken, Kundenlogos oder Testimonials,
- übermäßige Animationen,
- eine Aneinanderreihung gleich aussehender Abschnitte.

Karten dürfen nur verwendet werden, wenn Inhalte tatsächlich voneinander getrennte Leistungen oder Schritte darstellen. Nutze zusätzlich Bild-Text-Kompositionen, hervorgehobene Aussagen, klare Listen, Prozessdarstellungen oder ruhige redaktionelle Abschnitte.

AUFBAU DES ONEPAGERS
Nutze den gelieferten Blueprint als Grundlage, aber übersetze ihn in eine gestalterisch schlüssige Seite. Nicht jeder Inhalt benötigt eine eigene Sektion.

Die Seite sollte grundsätzlich enthalten:
- Header mit vorhandenem Logo oder Wortmarke,
- kompakte Anchor-Navigation,
- Hero mit klarem Nutzenversprechen und primärem CTA,
- früh sichtbaren Vertrauens- oder Differenzierungsfaktor,
- verständliche Darstellung der wichtigsten Leistungen,
- passende weitere Inhalte aus dem Blueprint,
- abschließenden Kontakt- oder CTA-Bereich,
- Footer mit Unternehmensname sowie Links zu Impressum und Datenschutz.

Im sichtbaren Hero-Bereich müssen Unternehmen, Leistung und primäre Handlung schnell verständlich sein. Vermeide leere Werbeaussagen wie „Willkommen bei uns“, „Ihre Zukunft beginnt hier“, „Innovation neu gedacht“ oder „Qualität trifft Leidenschaft“.

CTA-Elemente sind sparsam einzusetzen. Zeige den primären CTA im Hero und bei
Bedarf genau einmal erneut im abschließenden Kontaktbereich. Wiederhole ihn nicht
in direkt aufeinanderfolgenden Abschnitten, verwende keine dicht nebeneinander
stehenden doppelten CTA-Buttons und keine zusätzlichen CTA-Banner zwischen den
Inhaltsabschnitten. Ein sekundärer CTA ist nur erlaubt, wenn er ein anderes
nachvollziehbares Ziel besitzt, und soll visuell zurückhaltend sein. Alle
Navigationspunkte und Schaltflächen müssen auf vorhandene Bereiche oder bestätigte
URLs führen.

BILDER UND MEDIEN
- Orientiere dich am gelieferten Bildbriefing und an der Bildsprache der bestehenden Unternehmenswebsite.
- Bilder sollen glaubwürdig zur Branche passen, echte Arbeitssituationen oder nachvollziehbare Ergebnisse zeigen und die Inhalte unterstützen.
- Verwende keine erfundenen Firmenprojekte oder angeblichen Beschäftigten.
- Wenn kein geeignetes Bild verfügbar ist, nutze einen hochwertig gestalteten Platzhalter mit einer konkreten Beschreibung des benötigten Motivs.
- Verwende keine instabilen oder offensichtlich unpassenden externen Bildquellen.

TEXTREGELN
- Nutze die vorbereiteten Website-Texte.
- Schreibe klar, konkret und verständlich.
- Vermeide übertriebene Werbesprache, nicht belegte Superlative und generische KI-Floskeln.
- Verwende kein Lorem ipsum.
- Ergänze keine Leistungen, die nicht genannt wurden.
- Wiederhole dieselbe Aussage nicht in mehreren Abschnitten.
- Halte Überschriften kurz und aussagekräftig.
- Verwende die vorgesehene Ansprache konsequent.
- Übernimm SEO-Titel und Meta-Description aus den gelieferten Daten.

SEO- UND ÜBERSCHRIFTENSTRUKTUR
- Verwende auf der gesamten Seite genau eine H1.
- Die H1 beschreibt konkret Hauptleistung, Unternehmen und – sofern sinnvoll –
  Standort oder Region. Sie ist keine reine Werbefloskel.
- Jeder Hauptabschnitt beginnt mit einer aussagekräftigen H2, die auch ohne den
  übrigen Seitenkontext verständlich ist und reale Suchintentionen berücksichtigt.
- H3-Überschriften sind nur Unterpunkte einer zugehörigen H2.
- Überspringe keine Ebenen und nutze Überschriften nicht nur zur optischen
  Formatierung.
- Verwende relevante Begriffe natürlich und ohne Keyword-Stuffing.
- Vermeide mehrere Überschriften direkt hintereinander ohne erklärenden Inhalt.

BARRIEREFREIHEIT UND QUALITÄT
Achte auf ausreichende Farbkontraste, sichtbare Fokuszustände, vollständige Tastaturbedienbarkeit, eine sinnvolle Überschriftenstruktur, verständliche Link- und Buttontexte, sinnvolle Alt-Texte, korrekt beschriftete Formularfelder, gut lesbare Schriftgrößen und ausreichend große Bedienflächen. Verhindere horizontales Scrollen. Beachte die Systemeinstellung für reduzierte Bewegungen.

Animationen dürfen nur dezent eingesetzt werden und müssen die Bedienung unterstützen.

ABSCHLUSSPRÜFUNG
Beende die Aufgabe nicht nach dem ersten Gerüst. Prüfe vor Abschluss:
- Wurden vorhandenes Logo und Markenfarben erkannt und sinnvoll übernommen?
- Ist das vollständige Logo einschließlich Schriftzug auf seinem Hintergrund klar
  erkennbar und kontrastreich?
- Harmonieren Hintergrund- und Sekundärfarben sichtbar mit den echten
  Unternehmensfarben?
- Passt die Gestaltung sichtbar zu diesem konkreten Unternehmen?
- Wirkt die Seite ruhig und übersichtlich?
- Wirkt sie wie eine klare Unternehmens-Visitenkarte statt wie ein Flyer oder eine
  vertriebliche Landingpage?
- Wurden unnötige Banner, Stichwortstreifen, Rechtecke, Kacheln und CTA-Flächen
  vollständig entfernt?
- Sind keine Elemente zu eng nebeneinander angeordnet?
- Ist der Hero auf einem Smartphone sofort verständlich?
- Verwendet der Hero ein glaubwürdiges branchenspezifisches Motiv oder einen
  entsprechend konkreten Platzhalter?
- Gibt es nur eine H1 sowie eine logisch aufgebaute, SEO-sinnvolle H2-H3-Struktur?
- Stehen keine zwei gleichwertigen CTA-Buttons eng nebeneinander und wird der CTA
  insgesamt sparsam verwendet?
- Sind alle wichtigen Inhalte enthalten?
- Wurden keine unbestätigten Fakten ergänzt?
- Funktionieren Navigation und CTAs?
- Sind keine leeren oder offensichtlich unfertigen Bereiche vorhanden?
- Ist die Seite bei 360, 768, 1024 und 1440 Pixel Breite nutzbar?
- Startet und baut das Projekt ohne Fehler?

Behebe gefundene Probleme selbstständig. Das Endergebnis muss als fertiger Website-Entwurf präsentiert werden können.

DIREKTE FORMULARDATEN
${JSON.stringify(directFormData, null, 2)}

BESTEHENDE WEBSITE
${sourceNote}

WEBSITE-BLUEPRINT
${JSON.stringify(blueprint, null, 2)}

FERTIGE WEBSITE-TEXTE
${JSON.stringify(websiteCopy, null, 2)}

Setze jetzt die vollständige Website um. Verwende die gelieferten Inhalte, den
primären CTA und die Bildbriefings, aber optimiere die Abschnittsreihenfolge, wenn
dies für ein ruhigeres und verständlicheres Gesamtergebnis notwendig ist.`;
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
            "design_direction",
            "design_style_id",
            "design_style_reason",
            "image_profile_id",
            "image_profile_reason",
            "hero_variant_id",
            "content_pattern_ids",
            "contact_variant_id",
            "component_reason"
          ],
          properties: {
            primary_goal: S,
            primary_cta: S,
            secondary_cta: S,
            tone: S,
            design_direction: S,
            design_style_id: {
              type: "string",
              enum: designCatalog.styles.map((style) => style.id)
            },
            design_style_reason: S,
            image_profile_id: {
              type: "string",
              enum: imageProfileCatalog.profiles.map((profile) => profile.id)
            },
            image_profile_reason: S,
            hero_variant_id: {
              type: "string",
              enum: componentCatalog.hero_variants.map((item) => item.id)
            },
            content_pattern_ids: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "string",
                enum: componentCatalog.content_patterns.map((item) => item.id)
              }
            },
            contact_variant_id: {
              type: "string",
              enum: componentCatalog.contact_variants.map((item) => item.id)
            },
            component_reason: S
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

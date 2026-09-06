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

const controller = new AbortController();
const geminiTimeout = setTimeout(() => {
  controller.abort();
}, 50000);

let response: any;

try {
  response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildPrompt(input, websiteText, websiteSource),
    config: {
      thinkingConfig: {
        thinkingLevel: "low"
      },
      responseMimeType: "application/json",
      responseSchema: OUTPUT_SCHEMA,
      maxOutputTokens: 8192,
      temperature: 0.3,
      abortSignal: controller.signal,
      httpOptions: {
        timeout: 50000
      }
    }
  });
} catch (error) {
  console.error("Gemini request failed", error);

  return res.status(502).json({
    ok: false,
    error:
      controller.signal.aborted
        ? "gemini_timeout"
        : "gemini_request_failed",
    details: error instanceof Error ? error.message : String(error)
  });
} finally {
  clearTimeout(geminiTimeout);
}

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


  const vibePrompt = buildV0Prompt(
    input,
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
      usage: response?.usageMetadata ?? null
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
  data: BusinessInput,
  blueprint: JsonRecord,
  websiteCopy: JsonRecord
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
- keine extern geladenen Schriftarten, sofern sie nicht ausdrücklich vorgegeben wurden
- performante und barrierearme Umsetzung
- direkt startbar und ohne Build-Fehler

PRIORITÄT DER INFORMATIONEN
Verwende Informationen in dieser Reihenfolge:
1. DIREKTE FORMULARDATEN: Diese Angaben wurden vom Unternehmen übermittelt und sind verbindlich.
2. WEBSITE-BLUEPRINT: Er dient als strategische Empfehlung für Aufbau, Ziel und Inhalte.
3. VORBEREITETE WEBSITE-TEXTE: Nutze sie als redaktionelle Grundlage. Du darfst sie für Layout und Verständlichkeit geringfügig kürzen, aber keine neuen Tatsachenbehauptungen ergänzen.
4. BESTEHENDE WEBSITE: Sie dient als wichtige Quelle für das vorhandene Markendesign, ist aber keine verlässliche Quelle für veränderliche Unternehmensangaben.

Bei Widersprüchen haben die direkten Formulardaten immer Vorrang.

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

Verwende keine Logos aus Branchenverzeichnissen, Suchergebnissen oder fremden Plattformen. Wenn das Logo nicht zuverlässig übernommen werden kann, verwende den Unternehmensnamen als zurückhaltende typografische Wortmarke. Erfinde kein neues Logo.

FARBEN
Leite die Farbpalette bevorzugt aus dem vorhandenen Logo und den wiederkehrenden Gestaltungselementen der bestehenden Website ab. Unterscheide echte Markenfarben von zufälligen Farben aus Fotos, Werbebannern, Cookie-Fenstern, Drittanbieter-Elementen oder Social-Media-Inhalten.

Reduziere die Farbpalette auf:
- eine dominante Markenfarbe,
- höchstens eine ergänzende Akzentfarbe,
- gut abgestimmte neutrale Hintergrund- und Textfarben.

Entwickle daraus eine moderne, barrierearme Farbpalette mit ausreichenden Kontrasten. Wenn keine erkennbare Markenidentität vorhanden ist, verwende eine hochwertige neutrale Basis und einen zur Branche passenden Akzent. Verwende nicht automatisch ein blaues Standarddesign.

GESTALTUNGSAUFGABE
Leite aus Branche, Leistungen, Zielgruppe, Standort, Alleinstellungsmerkmalen und bestehendem Markendesign ein eigenständiges visuelles Konzept ab. Entscheide dich intern für eine klare Gestaltungsrichtung und setze sie konsequent um.

Definiere:
- eine erkennbare visuelle Leitidee,
- eine zum Unternehmen passende Farbwelt,
- eine klare Schrift- und Größenhierarchie,
- einen konsistenten Umgang mit Flächen, Linien, Bildern und Abständen,
- eine nachvollziehbare CTA-Hierarchie,
- einen abwechslungsreichen, aber ruhigen Seitenrhythmus.

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
- Im Hero höchstens zwei Handlungsaufforderungen zeigen.
- Auf kleinen Bildschirmen keine Desktop-Anordnung künstlich beibehalten.

Wenn Inhalte nicht sinnvoll nebeneinander passen, ordne sie untereinander an. Übersichtlichkeit hat Vorrang vor einer besonders kompakten Seitendarstellung.

Der Onepager sollte in der Regel aus fünf bis sieben klar unterscheidbaren Hauptabschnitten bestehen. Fasse verwandte Inhalte zusammen, anstatt für jeden Datenpunkt eine neue Sektion zu erstellen.

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

Wiederhole den primären CTA an mindestens einer weiteren sinnvollen Stelle. Verwende einen sekundären CTA nur, wenn er ein anderes nachvollziehbares Ziel besitzt. Alle Navigationspunkte und Schaltflächen müssen auf vorhandene Bereiche oder bestätigte URLs führen.

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

BARRIEREFREIHEIT UND QUALITÄT
Achte auf ausreichende Farbkontraste, sichtbare Fokuszustände, vollständige Tastaturbedienbarkeit, eine sinnvolle Überschriftenstruktur, verständliche Link- und Buttontexte, sinnvolle Alt-Texte, korrekt beschriftete Formularfelder, gut lesbare Schriftgrößen und ausreichend große Bedienflächen. Verhindere horizontales Scrollen. Beachte die Systemeinstellung für reduzierte Bewegungen.

Animationen dürfen nur dezent eingesetzt werden und müssen die Bedienung unterstützen.

ABSCHLUSSPRÜFUNG
Beende die Aufgabe nicht nach dem ersten Gerüst. Prüfe vor Abschluss:
- Wurden vorhandenes Logo und Markenfarben erkannt und sinnvoll übernommen?
- Passt die Gestaltung sichtbar zu diesem konkreten Unternehmen?
- Wirkt die Seite ruhig und übersichtlich?
- Sind keine Elemente zu eng nebeneinander angeordnet?
- Ist der Hero auf einem Smartphone sofort verständlich?
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

Setze jetzt die vollständige Website um. Verwende die gelieferten Inhalte, CTAs und Bildbriefings, aber optimiere die Abschnittsreihenfolge, wenn dies für ein ruhigeres und verständlicheres Gesamtergebnis notwendig ist.`;
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

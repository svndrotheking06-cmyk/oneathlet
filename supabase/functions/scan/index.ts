// Analyse photo de l'assiette (OneAthlet Premium) : reconnaît les aliments et estime calories et macros avec Claude.
// Secret requis : ANTHROPIC_API_KEY.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("anthropic_api_key") });
const LANGS: Record<string, string> = { fr: "français", en: "anglais", es: "espagnol", de: "allemand", it: "italien", pt: "portugais", nl: "néerlandais", ar: "arabe", tr: "turc" };
const TYPES = ["image/jpeg", "image/png", "image/webp"];
const clean = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String(x).replace(/[^a-zà-ÿ_-]/gi, "").slice(0, 20)).filter(Boolean).slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ error: "Connectez-vous pour analyser vos repas." }, 401);

  const { data: ab } = await sb.from("abonnements").select("status,current_period_end").eq("user_id", user.id).maybeSingle();
  const premium = !!ab && (ab.status === "lifetime" || (["active", "trialing"].includes(ab.status) &&
    (!ab.current_period_end || new Date(ab.current_period_end).getTime() > Date.now() - 86_400_000)));
  if (!premium) return json({ error: "L'analyse photo est réservée aux membres Premium." }, 402);

  let body: { image?: unknown; mediaType?: unknown; diet?: unknown; intol?: unknown; lang?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Requête invalide" }, 400); }
  const image = typeof body.image === "string" ? body.image : "";
  const mediaType = TYPES.includes(String(body.mediaType)) ? String(body.mediaType) : "image/jpeg";
  if (!image || image.length > 7_000_000 || !/^[A-Za-z0-9+/=]+$/.test(image)) return json({ error: "Photo illisible ou trop lourde." }, 400);

  const diet = clean(body.diet), intol = clean(body.intol);
  const langue = LANGS[String(body.lang ?? "fr")] ?? "français";
  const profil = diet.length || intol.length
    ? `Profil du client : régime ${diet.join(", ") || "aucun"} ; intolérances ${intol.join(", ") || "aucune"}. Si un aliment ne convient pas à ce profil, signale-le en premier dans le conseil.\n`
    : "";
  const prompt = `Tu es un nutritionniste. Regarde la photo d'un repas. Identifie chaque aliment visible, estime sa portion en grammes d'après la taille de l'assiette, puis ses calories et macronutriments.
${profil}Écris les champs "plat", "nom" et "conseil" en ${langue}.
Réponds UNIQUEMENT avec un objet JSON de cette forme :
{"plat":"nom court du repas","aliments":[{"nom":"Riz blanc","emoji":"🍚","grammes":150,"kcal":195,"proteines":4,"glucides":43,"lipides":0}],"conseil":"une phrase courte pour rendre ce repas plus sain ou le féliciter","note":"A|B|C|D"}
"note" : A = très équilibré, D = à limiter. Si la photo ne montre pas de nourriture, renvoie {"plat":"","aliments":[],"conseil":"Aucun aliment détecté. Reprenez la photo de plus près.","note":""}.`;

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 3000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: prompt },
        ],
      }],
    } as any);
    if (response.stop_reason === "refusal") return json({ error: "Cette photo n'a pas pu être analysée. Essayez une autre photo." }, 422);
    const text = response.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return json({ error: "Résultat illisible. Réessayez." }, 502);
    let result: unknown;
    try { result = JSON.parse(text.slice(start, end + 1)); } catch { return json({ error: "Résultat illisible. Réessayez." }, 502); }
    return json({ result });
  } catch (err) {
    console.error(err);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "Trop de demandes. Réessayez dans une minute." }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "Clé IA invalide côté serveur." }, 500);
    if (err instanceof Anthropic.APIError) return json({ error: "L'analyse a échoué. Réessayez." }, 502);
    return json({ error: "Erreur inattendue." }, 500);
  }
});

// Coach IA OneAthlet : répond aux questions nutrition du client, en tenant compte de son plan.
// Accès : uniquement un client ayant payé une formule du quiz (identifié par sa session Stripe).
// Secrets requis : ANTHROPIC_API_KEY, STRIPE_SECRET.
import Anthropic from "npm:@anthropic-ai/sdk";
import Stripe from "npm:stripe@17.7.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("anthropic_api_key") });
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET") ?? Deno.env.get("SECRET_STRIPE") ?? Deno.env.get("STRIPE_SECRET_KEY") ?? Deno.env.get("stripe_secret_key") ?? "", { httpClient: Stripe.createFetchHttpClient() });

// Cache court des sessions vérifiées, pour ne pas interroger Stripe à chaque message.
const ok = new Map<string, number>();
async function quizPaid(sid: string): Promise<boolean> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) return false;
  const t = ok.get(sid);
  if (t && Date.now() - t < 10 * 60_000) return true;
  try {
    const s = await stripe.checkout.sessions.retrieve(sid);
    if (s.status !== "complete" || !["w4", "w12", "w52"].includes(String(s.metadata?.plan)) || !s.subscription) return false;
    const sub = await stripe.subscriptions.retrieve(typeof s.subscription === "string" ? s.subscription : s.subscription.id);
    const active = ["active", "trialing"].includes(sub.status);
    if (active) ok.set(sid, Date.now());
    return active;
  } catch (e) {
    console.error(e);
    return false;
  }
}

const txt = (v: unknown, n = 40) => String(v ?? "").replace(/[^\p{L}\p{N} .,'_-]/gu, "").slice(0, n);
const num = (v: unknown) => (Number.isFinite(+v!) ? Math.round(+v! * 10) / 10 : null);
const list = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => txt(x, 20)).filter(Boolean).slice(0, 15);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  let body: { sid?: unknown; messages?: unknown; profil?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: "Requête invalide" }, 400); }

  if (typeof body.sid !== "string" || !(await quizPaid(body.sid))) {
    return json({ error: "Le coach IA est réservé aux abonnés OneAthlet." }, 402);
  }

  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m: any) => ({ role: m.role as "user" | "assistant", content: String(m.content).slice(0, 1500) }))
    .slice(-12);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "Posez votre question." }, 400);

  const p = body.profil ?? {};
  const profil = [
    `sexe : ${p.sexe === "F" ? "femme" : "homme"}`,
    `âge : ${num(p.age) ?? "?"} ans`,
    `poids : ${num(p.poids) ?? "?"} kg, poids visé : ${num(p.cible) ?? "?"} kg`,
    `objectif : ${txt(p.objectif) || "?"}`,
    `objectif du jour : ${num(p.kcal) ?? "?"} kcal, ${num(p.proteines) ?? "?"} g protéines, ${num(p.glucides) ?? "?"} g glucides, ${num(p.lipides) ?? "?"} g lipides`,
    `régime : ${txt(p.regime) || "équilibré"}`,
    `intolérances : ${list(p.intolerances).join(", ") || "aucune"}`,
    `santé signalée : ${list(p.sante).join(", ") || "rien"}`,
    `aujourd'hui : ${num(p.mange_aujourdhui) ?? 0} kcal mangées, ${num(p.brule_aujourdhui) ?? 0} kcal brûlées`,
  ].join("\n");

  const system = `Tu es le coach nutrition de OneAthlet, une application de perte de poids et de nutrition.
Profil et plan du client :
${profil}

Règles :
- Réponds dans la langue du client, de façon chaleureuse, concrète et courte (5 phrases maximum, ou une petite liste).
- Appuie-toi sur son plan : calories, protéines, régime, intolérances. Ne propose jamais un aliment contraire à son régime ou à ses intolérances.
- Pas de régime extrême, pas de jeûne prolongé, jamais moins de 1200 kcal par jour pour une femme ni 1500 pour un homme.
- Tu ne remplaces pas un médecin : pour un problème de santé, un traitement (diabète, GLP-1…), une grossesse ou un trouble alimentaire, conseille d'en parler à un professionnel de santé.
- Si la question n'a rien à voir avec la nutrition, le sport ou le bien-être, ramène gentiment la conversation vers son plan.
- Écris en texte simple, sans Markdown.`;

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 1500,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: msgs,
    } as any);
    if (response.stop_reason === "refusal") return json({ reponse: "Je ne peux pas répondre à cette question. Parlons plutôt de votre plan !" });
    const text = response.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    return json({ reponse: text || "Pouvez-vous reformuler votre question ?" });
  } catch (err) {
    console.error(err);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "Trop de demandes. Réessayez dans une minute." }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "Clé IA invalide côté serveur." }, 500);
    return json({ error: "Le coach est indisponible pour le moment. Réessayez." }, 502);
  }
});

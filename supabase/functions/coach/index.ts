// Coach IA OneAthlet : reçoit la conversation et le profil du client, répond avec Claude.
// Secret requis : ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets).
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM = `Tu es le coach nutrition de OneAthlet, un site qui aide à perdre du poids, prendre du muscle, prendre du poids, mieux manger ou retrouver de l'énergie.
Réponds toujours en français, en tutoyant, avec des réponses courtes (5 à 8 lignes maximum), concrètes et motivantes.
Appuie-toi sur le profil du client fourni ci-dessous : objectif, calories, macros, ce qu'il a mangé aujourd'hui, régime, intolérances et aliments préférés. Ne propose jamais un aliment incompatible avec son régime ou ses intolérances.
Donne des quantités précises (grammes, portions) quand tu proposes un repas.
Tu n'es pas médecin : pas de diagnostic, pas de médicament. Si le client parle d'un problème de santé, de grossesse, de troubles alimentaires ou veut descendre sous 1 200 kcal par jour, conseille-lui avec bienveillance de consulter un médecin ou un diététicien.`;

const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? Deno.env.get("anthropic_api_key") });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  // Seuls les clients connectés peuvent utiliser le coach.
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ error: "Connectez-vous pour parler au coach." }, 401);

  // Le coach est réservé aux membres Premium.
  const { data: ab } = await sb.from("abonnements").select("status,current_period_end").eq("user_id", user.id).maybeSingle();
  const premium = !!ab && ["active", "trialing"].includes(ab.status) &&
    (!ab.current_period_end || new Date(ab.current_period_end).getTime() > Date.now() - 86_400_000);
  if (!premium) return json({ error: "Le coach IA est réservé aux membres Premium (14,99 €/mois)." }, 402);

  let body: { messages?: unknown; profile?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Requête invalide" }, 400); }

  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages: Anthropic.MessageParam[] = raw
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-20)
    .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "Message manquant" }, 400);
  const profile = typeof body.profile === "string" ? body.profile.slice(0, 4000) : "";

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: `${SYSTEM}\n\nProfil du client :\n${profile || "(non renseigné)"}`,
      messages,
    } as any);
    if (response.stop_reason === "refusal") {
      return json({ reply: "Je ne peux pas répondre à cette question. Pose-moi une question sur ton alimentation ou ton plan." });
    }
    const reply = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    return json({ reply: reply || "Je n'ai pas de réponse pour l'instant, réessaie." });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: "Le coach est très demandé. Réessaie dans une minute." }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "Clé IA invalide côté serveur." }, 500);
    if (err instanceof Anthropic.APIError) return json({ error: "Le coach n'a pas pu répondre. Réessaie." }, 502);
    return json({ error: "Erreur inattendue." }, 500);
  }
});

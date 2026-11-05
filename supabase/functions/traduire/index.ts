// Traduction du site OneAthlet : reçoit des textes français (avec {0}, {1}… à la place des nombres),
// renvoie leur traduction. Chaque traduction est gardée en base : elle n'est demandée à l'IA qu'une seule fois par langue.
// Secrets requis : ANTHROPIC_API_KEY (SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont fournis par Supabase).
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
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const MAX_TEXTS = 200, MAX_LEN = 800, MAX_TOTAL = 40_000, DAILY_NEW = 60_000;

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function langName(code: string) {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; } catch { return code; }
}
const holes = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join(",");

async function ask(lang: string, texts: string[]): Promise<string[] | null> {
  const name = langName(lang);
  const system = `You translate the French user interface of OneAthlet, a weight-loss and nutrition website, into ${name} (language code "${lang}").
Rules:
- Translate each string of the JSON array, in order. Return ONLY a JSON array of strings with exactly the same number of items.
- Keep placeholders like {0}, {1} exactly as they are (they stand for numbers), and keep emojis, punctuation, € and units (kg, cm, kcal, g, L, km, min).
- Keep "OneAthlet" unchanged. Keep the meaning, tone and length close to the original; this is website copy (buttons, titles, short sentences).
- If a string is already not French or cannot be translated, return it unchanged.`;
  const r = await client.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: JSON.stringify(texts) }],
  });
  const text = r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const a = text.indexOf("["), z = text.lastIndexOf("]");
  if (a < 0 || z <= a) return null;
  try {
    const out = JSON.parse(text.slice(a, z + 1));
    if (!Array.isArray(out) || out.length !== texts.length) return null;
    return out.map((t, i) => (typeof t === "string" && t.trim() && holes(t) === holes(texts[i]) ? t : texts[i]));
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  let body: { lang?: unknown; texts?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Requête invalide" }, 400); }
  const lang = String(body.lang ?? "");
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang) || lang === "fr") return json({ error: "Langue invalide" }, 400);

  const texts = [...new Set((Array.isArray(body.texts) ? body.texts : []).filter((t) => typeof t === "string").map((t) => (t as string).trim()))]
    .filter((t) => t && t.length <= MAX_LEN && /\p{L}/u.test(t)).slice(0, MAX_TEXTS);
  if (!texts.length) return json({ t: {} });
  if (texts.reduce((n, t) => n + t.length, 0) > MAX_TOTAL) return json({ error: "Trop de texte" }, 413);

  const hs = await Promise.all(texts.map(sha));
  const t: Record<string, string> = {};
  const { data: rows } = await db.from("traductions").select("h,trad").eq("lang", lang).in("h", hs);
  const have = new Map((rows ?? []).map((r: any) => [r.h, r.trad]));
  const miss: string[] = [];
  texts.forEach((s, i) => { const v = have.get(hs[i]); if (v != null) t[s] = v; else miss.push(s); });
  if (!miss.length) return json({ t });

  // Garde-fou contre les abus : nombre limité de nouvelles traductions par jour.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db.from("traductions").select("h", { count: "exact", head: true }).gte("created_at", since);
  if ((count ?? 0) > DAILY_NEW) return json({ t });

  try {
    for (let i = 0; i < miss.length; i += 60) {
      const part = miss.slice(i, i + 60);
      const out = await ask(lang, part);
      if (!out) continue;
      const ins = await Promise.all(part.map(async (s, k) => ({ lang, h: await sha(s), src: s, trad: out[k] })));
      part.forEach((s, k) => { t[s] = out[k]; });
      await db.from("traductions").upsert(ins, { onConflict: "lang,h", ignoreDuplicates: true });
    }
  } catch (err) {
    console.error(err);
  }
  return json({ t });
});

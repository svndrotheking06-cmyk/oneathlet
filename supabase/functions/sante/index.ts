// Réception des données d'Apple Santé pour l'espace abonné OneAthlet.
// Envoyées par le Raccourci iPhone du client (ou plus tard par une appli iOS), avec son jeton personnel.
// Corps JSON : { token, jour?: "AAAA-MM-JJ", pas?, kcal_actives?, distance_km?, minutes? }
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Les Raccourcis envoient parfois « 7 254 » ou « 312,5 » : on nettoie.
const nombre = (v: unknown, max: number) => {
  if (v == null || v === "") return undefined;
  const n = Number(String(v).replace(/[\s  ]/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 10) / 10 : undefined;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return json({ error: "JSON invalide" }, 400); }

  const token = String(b.token ?? "");
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ error: "Jeton invalide" }, 401);
  const { data: p } = await db.from("espace_profils").select("client").eq("sante_token", token).maybeSingle();
  if (!p) return json({ error: "Jeton inconnu : reconnectez Apple Santé depuis votre espace." }, 401);

  const jour = /^\d{4}-\d{2}-\d{2}$/.test(String(b.jour ?? "")) ? String(b.jour) : new Date().toISOString().slice(0, 10);
  const sante: Record<string, number | string> = { recu: new Date().toISOString() };
  const champs: [string, number][] = [["pas", 200_000], ["kcal_actives", 20_000], ["distance_km", 500], ["minutes", 1_440]];
  for (const [k, max] of champs) { const v = nombre(b[k], max); if (v !== undefined) sante[k] = v; }
  if (Object.keys(sante).length === 1) return json({ error: "Aucune donnée reçue" }, 400);

  const { data: ex } = await db.from("espace_jours").select("sante").eq("client", p.client).eq("jour", jour).maybeSingle();
  const { error } = await db.from("espace_jours").upsert(
    { client: p.client, jour, sante: { ...(ex?.sante ?? {}), ...sante }, updated_at: new Date().toISOString() },
    { onConflict: "client,jour", ignoreDuplicates: false },
  );
  if (error) { console.error(error); return json({ error: "Enregistrement impossible" }, 500); }
  return json({ ok: true, jour, recu: sante });
});

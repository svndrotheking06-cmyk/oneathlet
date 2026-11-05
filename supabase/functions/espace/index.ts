// Espace abonné OneAthlet (Nutrition, Progrès, Recettes) : lecture et sauvegarde des données du client.
// Accès : uniquement avec une session Stripe d'abonnement du quiz, actif ou en essai (vérifié ici, côté serveur).
// Les données sont rangées par client Stripe : elles suivent le client d'un appareil à l'autre.
// Secrets requis : STRIPE_SECRET (SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont fournis par Supabase).
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET") ?? Deno.env.get("SECRET_STRIPE") ?? Deno.env.get("STRIPE_SECRET_KEY") ?? Deno.env.get("stripe_secret_key") ?? "", { httpClient: Stripe.createFetchHttpClient() });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const PLANS = ["w4", "w12", "w52"];
const MESURES = ["poids", "taille", "poitrine", "hanches", "bras", "cuisse", "epaules", "masse_grasse", "masse_musculaire"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Session Stripe -> client Stripe, si l'abonnement est actif ou en essai. Gardé 10 minutes en mémoire.
const cache = new Map<string, { client: string; t: number }>();
async function abonne(sid: string): Promise<string | null> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) return null;
  const c = cache.get(sid);
  if (c && Date.now() - c.t < 10 * 60_000) return c.client;
  try {
    const s = await stripe.checkout.sessions.retrieve(sid);
    if (s.status !== "complete" || !PLANS.includes(String(s.metadata?.plan)) || !s.subscription) return null;
    const sub = await stripe.subscriptions.retrieve(typeof s.subscription === "string" ? s.subscription : s.subscription.id);
    if (!["active", "trialing"].includes(sub.status)) return null;
    const client = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    cache.set(sid, { client, t: Date.now() });
    return client;
  } catch (e) {
    console.error(e);
    return null;
  }
}

const taille = (v: unknown) => JSON.stringify(v ?? null).length;
const signer = async (chemin: string) => (await db.storage.from("progres").createSignedUrl(chemin, 3600)).data?.signedUrl ?? null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return json({ error: "Requête invalide" }, 400); }

  const client = await abonne(String(b.sid ?? ""));
  if (!client) return json({ error: "Cet espace est réservé aux abonnés OneAthlet." }, 402);

  try {
    // Le profil est créé à la première visite.
    await db.from("espace_profils").upsert({ client }, { onConflict: "client", ignoreDuplicates: true });

    switch (b.action) {
      case "charger": {
        const from = DATE.test(b.from) ? b.from : "2000-01-01", to = DATE.test(b.to) ? b.to : "2100-01-01";
        const [p, j, m, ph] = await Promise.all([
          db.from("espace_profils").select("reglages,favoris,sante_token").eq("client", client).single(),
          db.from("espace_jours").select("jour,data,sante").eq("client", client).gte("jour", from).lte("jour", to).order("jour"),
          db.from("espace_mesures").select("jour,type,valeur").eq("client", client).order("jour"),
          db.from("espace_photos").select("jour,chemin").eq("client", client).order("jour"),
        ]);
        const photos = ph.data ?? [];
        const ends = photos.length ? [photos[0], photos[photos.length - 1]] : [];
        const urls = await Promise.all(ends.map(async (x) => ({ jour: x.jour, url: await signer(x.chemin) })));
        return json({
          reglages: p.data?.reglages ?? {}, favoris: p.data?.favoris ?? [], sante: !!p.data?.sante_token,
          jours: j.data ?? [], mesures: m.data ?? [], photos: { total: photos.length, premiere: urls[0] ?? null, derniere: urls[1] ?? null },
        });
      }
      case "jour": {
        if (!DATE.test(b.jour) || typeof b.data !== "object" || taille(b.data) > 60_000) return json({ error: "Données invalides" }, 400);
        const { error } = await db.from("espace_jours").upsert({ client, jour: b.jour, data: b.data, updated_at: new Date().toISOString() }, { onConflict: "client,jour" });
        if (error) throw error;
        return json({ ok: true });
      }
      case "reglages": {
        if (typeof b.reglages !== "object" || taille(b.reglages) > 20_000) return json({ error: "Données invalides" }, 400);
        const { error } = await db.from("espace_profils").update({ reglages: b.reglages, updated_at: new Date().toISOString() }).eq("client", client);
        if (error) throw error;
        return json({ ok: true });
      }
      case "favoris": {
        const f = (Array.isArray(b.favoris) ? b.favoris : []).map(String).slice(0, 300);
        const { error } = await db.from("espace_profils").update({ favoris: f, updated_at: new Date().toISOString() }).eq("client", client);
        if (error) throw error;
        return json({ ok: true });
      }
      case "mesure": {
        if (!DATE.test(b.jour) || !MESURES.includes(b.type)) return json({ error: "Données invalides" }, 400);
        if (b.valeur == null || b.valeur === "") {
          await db.from("espace_mesures").delete().eq("client", client).eq("jour", b.jour).eq("type", b.type);
          return json({ ok: true });
        }
        const v = Math.round(Number(b.valeur) * 10) / 10;
        if (!(v > 0 && v < 1000)) return json({ error: "Valeur invalide" }, 400);
        const { error } = await db.from("espace_mesures").upsert({ client, jour: b.jour, type: b.type, valeur: v }, { onConflict: "client,jour,type" });
        if (error) throw error;
        return json({ ok: true });
      }
      case "photo": {
        const img = String(b.image ?? "");
        if (!DATE.test(b.jour) || !img || img.length > 2_600_000 || !/^[A-Za-z0-9+/=]+$/.test(img)) return json({ error: "Photo invalide ou trop lourde." }, 400);
        const chemin = `${client}/${b.jour}.jpg`;
        const bytes = Uint8Array.from(atob(img), (c) => c.charCodeAt(0));
        const up = await db.storage.from("progres").upload(chemin, bytes, { contentType: "image/jpeg", upsert: true });
        if (up.error) throw up.error;
        await db.from("espace_photos").upsert({ client, jour: b.jour, chemin }, { onConflict: "client,jour" });
        return json({ ok: true, url: await signer(chemin) });
      }
      case "photo_suppr": {
        if (!DATE.test(b.jour)) return json({ error: "Données invalides" }, 400);
        await db.storage.from("progres").remove([`${client}/${b.jour}.jpg`]);
        await db.from("espace_photos").delete().eq("client", client).eq("jour", b.jour);
        return json({ ok: true });
      }
      case "sante_token": {
        // Jeton personnel pour le Raccourci iPhone qui envoie les données d'Apple Santé à la fonction « sante ».
        const { data } = await db.from("espace_profils").select("sante_token").eq("client", client).single();
        let token = data?.sante_token;
        if (!token || b.nouveau === true) {
          token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
          await db.from("espace_profils").update({ sante_token: token }).eq("client", client);
        }
        return json({ token });
      }
      case "sante_off": {
        await db.from("espace_profils").update({ sante_token: null }).eq("client", client);
        return json({ ok: true });
      }
      case "effacer": {
        // Supprime toutes les données de l'espace (l'abonnement Stripe n'est pas touché).
        const { data: files } = await db.storage.from("progres").list(client, { limit: 1000 });
        if (files?.length) await db.storage.from("progres").remove(files.map((f) => `${client}/${f.name}`));
        await db.from("espace_profils").delete().eq("client", client);
        cache.delete(String(b.sid));
        return json({ ok: true });
      }
      default:
        return json({ error: "Action inconnue" }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "Enregistrement impossible pour le moment. Réessayez." }, 500);
  }
});

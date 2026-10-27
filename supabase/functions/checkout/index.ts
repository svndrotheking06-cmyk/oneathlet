// Paiement OneAthlet Premium (14,99 €/mois) avec Stripe Checkout, et accès au portail client.
// Secrets requis : STRIPE_SECRET_KEY. Optionnel : STRIPE_PRICE_ID (sinon le prix est créé à la volée).
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { httpClient: Stripe.createFetchHttpClient() });

// Adresses de retour autorisées après le paiement.
function safeReturn(url: unknown): string | null {
  try {
    const u = new URL(String(url));
    const extra = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const ok = u.protocol === "https:" &&
      (u.hostname.endsWith(".vercel.app") || u.hostname === "svndrotheking06-cmyk.github.io" || extra.includes(u.origin));
    return ok ? u.origin + u.pathname : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Connectez-vous pour continuer." }, 401);

  let body: { action?: string; returnUrl?: string };
  try { body = await req.json(); } catch { body = {}; }
  const back = safeReturn(body.returnUrl);
  if (!back) return json({ error: "Adresse de retour non autorisée." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: row } = await admin.from("abonnements").select("*").eq("user_id", user.id).maybeSingle();

  try {
    if (body.action === "portal") {
      if (!row?.stripe_customer_id) return json({ error: "Aucun abonnement trouvé." }, 404);
      const portal = await stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: back + "#plan" });
      return json({ url: portal.url });
    }

    if (row && ["active", "trialing"].includes(row.status)) return json({ already: true });

    const priceId = Deno.env.get("STRIPE_PRICE_ID");
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [priceId ? { price: priceId, quantity: 1 } : {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: 1499,
          recurring: { interval: "month" },
          product_data: { name: "OneAthlet Premium", description: "Programme nutrition complet et coach IA." },
        },
      }],
      client_reference_id: user.id,
      ...(row?.stripe_customer_id ? { customer: row.stripe_customer_id } : { customer_email: user.email }),
      subscription_data: { metadata: { user_id: user.id } },
      metadata: { user_id: user.id },
      allow_promotion_codes: true,
      locale: "fr",
      success_url: back + "?premium=ok#plan",
      cancel_url: back + "#plan",
    });
    return json({ url: session.url });
  } catch (err) {
    console.error(err);
    return json({ error: "Le paiement n'a pas pu démarrer. Réessayez." }, 502);
  }
});

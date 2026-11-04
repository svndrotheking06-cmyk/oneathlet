// Paiement OneAthlet Premium (Stripe Checkout) : formules du quiz sur 4, 12 ou 52 semaines (sans compte),
// anciennes formules 14,99 €/mois et 89,99 € à vie (compte requis), et accès au portail client.
// Secrets requis : STRIPE_SECRET_KEY. Optionnels : STRIPE_PRICE_ID (sinon le prix est créé à la volée),
// RESEND_API_KEY et RESEND_FROM (envoi de l'e-mail « Votre plan est prêt » aux clients du quiz).
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

// Adresses de retour autorisées après le paiement.
function safeReturn(url: unknown): string | null {
  try {
    const u = new URL(String(url));
    const extra = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const ok = u.protocol === "https:" &&
      (u.hostname.endsWith(".vercel.app") || ["oneathlet.com", "www.oneathlet.com", "svndrotheking06-cmyk.github.io"].includes(u.hostname) || extra.includes(u.origin));
    return ok ? u.origin + u.pathname : null;
  } catch {
    return null;
  }
}

// Formules du quiz : abonnement renouvelé toutes les 4, 12 ou 52 semaines.
const PLANS: Record<string, { weeks: number; cents: number; name: string }> = {
  w4: { weeks: 4, cents: 999, name: "OneAthlet · plan 4 semaines" },
  w12: { weeks: 12, cents: 1999, name: "OneAthlet · plan 12 semaines" },
  w52: { weeks: 52, cents: 3999, name: "OneAthlet · plan 52 semaines" },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  let body: { action?: string; plan?: string; returnUrl?: string; sessionId?: string; email?: string; cible?: number; sid?: string };
  try { body = await req.json(); } catch { body = {}; }

  // Paiement depuis le quiz, sans compte : l'e-mail saisi sert d'identifiant client.
  if (body.action === "quiz") {
    const plan = PLANS[String(body.plan)];
    const email = String(body.email ?? "").trim().slice(0, 254);
    const back = safeReturn(body.returnUrl);
    if (!plan) return json({ error: "Formule inconnue." }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Adresse e-mail invalide." }, 400);
    if (!back) return json({ error: "Adresse de retour non autorisée." }, 400);
    const cible = Number(body.cible);
    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: plan.cents,
            recurring: { interval: "week", interval_count: plan.weeks },
            product_data: { name: plan.name, description: `Programme nutrition personnalisé${cible > 0 && cible < 300 ? ` pour atteindre ${cible} kg` : ""}, renouvelé toutes les ${plan.weeks} semaines.` },
          },
        }],
        customer_email: email,
        subscription_data: { metadata: { email, plan: String(body.plan) } },
        metadata: { email, plan: String(body.plan) },
        allow_promotion_codes: true,
        locale: "fr",
        success_url: back + "?paiement=ok&sid={CHECKOUT_SESSION_ID}",
        cancel_url: back + "?paiement=annule",
      });
      return json({ url: session.url });
    } catch (err) {
      console.error(err);
      return json({ error: "Le paiement n'a pas pu démarrer. Réessayez." }, 502);
    }
  }

  // Espace « Mon plan » des clients du quiz : la session Stripe sert de clé d'accès.
  if (body.action === "monplan" || body.action === "monportail") {
    const sid = String(body.sid ?? "");
    if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) return json({ error: "Lien invalide." }, 400);
    try {
      const s = await stripe.checkout.sessions.retrieve(sid);
      if (s.status !== "complete" || !PLANS[String(s.metadata?.plan)] || !s.subscription) return json({ error: "Paiement introuvable ou non finalisé." }, 402);
      const sub = await stripe.subscriptions.retrieve(typeof s.subscription === "string" ? s.subscription : s.subscription.id);
      const customer = typeof s.customer === "string" ? s.customer : s.customer?.id;
      if (body.action === "monportail") {
        const back = safeReturn(body.returnUrl);
        if (!back || !customer) return json({ error: "Gestion de l'abonnement indisponible." }, 400);
        const portal = await stripe.billingPortal.sessions.create({ customer, return_url: back + "?plan=" + sid });
        return json({ url: portal.url });
      }
      const active = ["active", "trialing"].includes(sub.status);
      const email = String(s.customer_details?.email ?? s.metadata?.email ?? "");
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      let { data: lead } = await admin.from("leads").select("id,reponses,plan_envoye_at").eq("stripe_session", sid).maybeSingle();
      if (!lead && email) {
        const { data: found } = await admin.from("leads").select("id,reponses,plan_envoye_at").ilike("email", email).order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (found) { lead = found; await admin.from("leads").update({ stripe_session: sid }).eq("id", found.id); }
      }
      // E-mail « Votre plan est prêt », envoyé une seule fois.
      const resend = Deno.env.get("RESEND_API_KEY");
      const back = safeReturn(body.returnUrl) ?? "https://oneathlet.com/";
      if (active && resend && email && lead && !lead.plan_envoye_at) {
        const link = back + "?plan=" + sid;
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: Deno.env.get("RESEND_FROM") ?? "OneAthlet <plan@oneathlet.com>",
            to: [email],
            subject: "Votre plan OneAthlet est prêt 🎉",
            html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#2A141A"><h1 style="color:#E11D48">Votre plan est prêt</h1><p>Merci pour votre confiance ! Votre programme a été calculé à partir de vos réponses au quiz : calories, macros, menus adaptés à votre régime et analyse de vos repas en photo.</p><p style="text-align:center;margin:28px 0"><a href="${link}" style="background:#E11D48;color:#fff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:999px;display:inline-block">Ouvrir mon plan</a></p><p style="font-size:13px;color:#7A5F67">Gardez cet e-mail : ce lien est votre accès personnel. Vous pouvez gérer ou résilier votre abonnement depuis votre plan.</p></div>`,
          }),
        });
        if (r.ok) await admin.from("leads").update({ plan_envoye_at: new Date().toISOString() }).eq("id", lead.id);
        else console.error("resend", r.status, await r.text());
      }
      const end = (sub as any).current_period_end ?? (sub.items?.data?.[0] as any)?.current_period_end;
      return json({ active, email, plan: s.metadata?.plan, reponses: lead?.reponses ?? null, renouvellement: end ? new Date(end * 1000).toISOString() : null, annule: !!sub.cancel_at_period_end });
    } catch (err) {
      console.error(err);
      return json({ error: "Impossible de vérifier votre accès. Réessayez." }, 502);
    }
  }

  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Connectez-vous pour continuer." }, 401);

  const back = safeReturn(body.returnUrl);
  if (!back) return json({ error: "Adresse de retour non autorisée." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: row } = await admin.from("abonnements").select("*").eq("user_id", user.id).maybeSingle();

  try {
    // Vérifie l'abonnement directement auprès de Stripe (aucun webhook nécessaire).
    if (body.action === "status") {
      if (row?.status === "lifetime") return json({ premium: true, lifetime: true });
      let sub: Stripe.Subscription | null = null;
      if (body.sessionId && /^cs_[A-Za-z0-9_]+$/.test(body.sessionId)) {
        const s = await stripe.checkout.sessions.retrieve(body.sessionId);
        // Accès à vie : paiement unique confirmé.
        if (s.client_reference_id === user.id && s.mode === "payment" && s.payment_status === "paid" && s.metadata?.plan === "lifetime") {
          if (row?.stripe_subscription_id && ["active", "trialing"].includes(row.status)) {
            try { await stripe.subscriptions.cancel(row.stripe_subscription_id); } catch (e) { console.error(e); }
          }
          await admin.from("abonnements").upsert({
            user_id: user.id,
            stripe_customer_id: typeof s.customer === "string" ? s.customer : s.customer?.id ?? row?.stripe_customer_id ?? null,
            stripe_subscription_id: null,
            status: "lifetime",
            current_period_end: null,
            updated_at: new Date().toISOString(),
          });
          return json({ premium: true, lifetime: true });
        }
        if (s.client_reference_id === user.id && s.subscription) {
          sub = await stripe.subscriptions.retrieve(typeof s.subscription === "string" ? s.subscription : s.subscription.id);
        }
      }
      if (!sub && row?.stripe_subscription_id) {
        sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      }
      if ((!sub || !["active", "trialing"].includes(sub.status)) && /^[0-9a-f-]{36}$/.test(user.id)) {
        const found = await stripe.subscriptions.search({ query: `metadata['user_id']:'${user.id}'`, limit: 10 });
        sub = found.data.find((x) => ["active", "trialing"].includes(x.status)) ?? sub ?? found.data[0] ?? null;
      }
      if (!sub) return json({ premium: false });
      const end = (sub as any).current_period_end ?? (sub.items?.data?.[0] as any)?.current_period_end;
      await admin.from("abonnements").upsert({
        user_id: user.id,
        stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
        stripe_subscription_id: sub.id,
        status: sub.status,
        current_period_end: end ? new Date(end * 1000).toISOString() : null,
        updated_at: new Date().toISOString(),
      });
      return json({ premium: ["active", "trialing"].includes(sub.status) });
    }

    if (body.action === "portal") {
      if (!row?.stripe_customer_id) return json({ error: "Aucun abonnement trouvé." }, 404);
      const portal = await stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: back + "#plan" });
      return json({ url: portal.url });
    }

    if (row && ["active", "trialing", "lifetime"].includes(row.status) && !(body.plan === "lifetime" && row.status !== "lifetime")) {
      return json({ already: true });
    }

    if (body.plan === "lifetime") {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: 8999,
            product_data: { name: "OneAthlet Premium à vie", description: "Programme nutrition complet et coach IA, payé une seule fois." },
          },
        }],
        client_reference_id: user.id,
        ...(row?.stripe_customer_id ? { customer: row.stripe_customer_id } : { customer_email: user.email, customer_creation: "always" }),
        metadata: { user_id: user.id, plan: "lifetime" },
        payment_intent_data: { metadata: { user_id: user.id, plan: "lifetime" } },
        allow_promotion_codes: true,
        locale: "fr",
        success_url: back + "?premium=ok&sid={CHECKOUT_SESSION_ID}#plan",
        cancel_url: back + "#plan",
      });
      return json({ url: session.url });
    }

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
      success_url: back + "?premium=ok&sid={CHECKOUT_SESSION_ID}#plan",
      cancel_url: back + "#plan",
    });
    return json({ url: session.url });
  } catch (err) {
    console.error(err);
    return json({ error: "Le paiement n'a pas pu démarrer. Réessayez." }, 502);
  }
});

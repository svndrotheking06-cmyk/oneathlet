// Reçoit les événements Stripe et met à jour la table abonnements.
// Secrets requis : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET. Vérification JWT désactivée (voir supabase/config.toml).
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET") ?? Deno.env.get("SECRET_STRIPE") ?? Deno.env.get("STRIPE_SECRET_KEY") ?? Deno.env.get("stripe_secret_key") ?? "", { httpClient: Stripe.createFetchHttpClient() });
const crypto = Stripe.createSubtleCryptoProvider();
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function save(sub: Stripe.Subscription, fallbackUserId?: string | null) {
  const userId = sub.metadata?.user_id || fallbackUserId;
  if (!userId) return;
  const { data: cur } = await admin.from("abonnements").select("status").eq("user_id", userId).maybeSingle();
  if (cur?.status === "lifetime") return; // l'accès à vie ne dépend plus d'un abonnement
  // current_period_end est sur l'abonnement dans les anciennes versions de l'API, sur l'article dans les nouvelles.
  const end = (sub as any).current_period_end ?? (sub.items?.data?.[0] as any)?.current_period_end;
  const { error } = await admin.from("abonnements").upsert({
    user_id: userId,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
    status: sub.status,
    current_period_end: end ? new Date(end * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

Deno.serve(async (req) => {
  const signature = req.headers.get("Stripe-Signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature ?? "", Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? Deno.env.get("stripe_webhook_secret") ?? "", undefined, crypto);
  } catch {
    return new Response("Signature invalide", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.mode === "subscription" && s.subscription) {
          const sub = await stripe.subscriptions.retrieve(typeof s.subscription === "string" ? s.subscription : s.subscription.id);
          await save(sub, s.client_reference_id);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await save(event.data.object as Stripe.Subscription);
        break;
    }
  } catch (err) {
    console.error(err);
    return new Response("Erreur", { status: 500 }); // Stripe réessaiera
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});

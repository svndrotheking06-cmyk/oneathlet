# OneAthlet

Site de nutrition : programmes (perte de poids, muscle, prise de poids, équilibre, énergie), quiz de bilan, plan calorique, suivi des repas, de l'eau et du poids, menus de la semaine.

Site en ligne : https://oneathlet.com

Ouvrir `index.html` dans un navigateur, ou activer GitHub Pages (Settings → Pages → branche `main`).

## Supabase

Comptes clients, sauvegarde du suivi et avis passent par Supabase. Pour créer les tables : copier `supabase.sql` dans Supabase → SQL Editor, puis « Run ».

## Coach IA

Le coach passe par la fonction Supabase `supabase/functions/coach` (Claude). À déployer dans Supabase → Edge Functions, sous le nom `coach`, avec le secret `ANTHROPIC_API_KEY`.

## Premium (Stripe)

Offre OneAthlet Premium à 14,99 €/mois : plan complet, résultats de la journée, menus et coach IA. Fonctions `supabase/functions/checkout` et `supabase/functions/stripe-webhook`, secrets `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET`, table `abonnements` dans `supabase.sql`.

Analyse photo de l'assiette : fonction Supabase `supabase/functions/scan` (Premium, clé `ANTHROPIC_API_KEY`).

## Chat Crisp

Le chat en direct Crisp est ajouté par `build.sh`, qui construit `index.html` à partir de la page source. Quand un client est connecté, son e-mail est transmis à Crisp.

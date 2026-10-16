# OneAthlet

Site de nutrition : programmes (perte de poids, muscle, prise de poids, équilibre, énergie), quiz de bilan, plan calorique, suivi des repas, de l'eau et du poids, menus de la semaine.

Ouvrir `index.html` dans un navigateur, ou activer GitHub Pages (Settings → Pages → branche `main`).

## Supabase

Comptes clients, sauvegarde du suivi et avis passent par Supabase. Pour créer les tables : copier `supabase.sql` dans Supabase → SQL Editor, puis « Run ».

## Coach IA

Le coach passe par la fonction Supabase `supabase/functions/coach` (Claude). À déployer dans Supabase → Edge Functions, sous le nom `coach`, avec le secret `ANTHROPIC_API_KEY`.

L'analyse photo de l'assiette fonctionne uniquement dans la version publiée sur Claude.

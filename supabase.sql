-- OneAthlet : tables et règles de sécurité Supabase.
-- À coller dans Supabase → SQL Editor → New query, puis « Run ».

-- 1. Données de suivi de chaque client (profil, quiz, repas, eau, poids)
create table if not exists public.profils (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  state jsonb not null default '{}'::jsonb check (pg_column_size(state) < 300000),
  updated_at timestamptz not null default now()
);

alter table public.profils enable row level security;

drop policy if exists "profils lecture perso" on public.profils;
drop policy if exists "profils creation perso" on public.profils;
drop policy if exists "profils maj perso" on public.profils;

create policy "profils lecture perso" on public.profils
  for select to authenticated using (auth.uid() = user_id);
create policy "profils creation perso" on public.profils
  for insert to authenticated with check (auth.uid() = user_id);
create policy "profils maj perso" on public.profils
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 2. Avis clients : lisibles par tous, un avis par compte, modifiable par son auteur
create table if not exists public.avis (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique default auth.uid() references auth.users (id) on delete cascade,
  prenom text not null check (char_length(prenom) between 1 and 24),
  texte text not null check (char_length(texte) between 1 and 280),
  note int not null check (note between 1 and 5),
  kilos numeric not null default 0 check (kilos between 0 and 150),
  created_at timestamptz not null default now()
);

alter table public.avis enable row level security;

drop policy if exists "avis lecture publique" on public.avis;
drop policy if exists "avis creation perso" on public.avis;
drop policy if exists "avis maj perso" on public.avis;
drop policy if exists "avis suppression perso" on public.avis;

create policy "avis lecture publique" on public.avis
  for select to anon, authenticated using (true);
create policy "avis creation perso" on public.avis
  for insert to authenticated with check (auth.uid() = user_id);
create policy "avis maj perso" on public.avis
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "avis suppression perso" on public.avis
  for delete to authenticated using (auth.uid() = user_id);

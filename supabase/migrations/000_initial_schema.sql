--
-- PostgreSQL database dump
--

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.10 (Ubuntu 17.10-1.pgdg22.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--
-- NOTE: Supabase auto-creates the `public` schema on every new project, so
-- this statement runs against an already-existing schema. `IF NOT EXISTS`
-- keeps the migration idempotent across Supabase Cloud, self-hosted
-- Supabase via Docker, and bare Postgres. Do not strip the guard.
--

CREATE SCHEMA IF NOT EXISTS public;

--
-- Name: waypoint_user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.waypoint_user_role AS ENUM (
    'admin',
    'editor',
    'viewer'
);

--
-- Name: admin_add_to_allowlist(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_add_to_allowlist(p_email text, p_role text DEFAULT 'viewer'::text, p_note text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if (select role::text from public.user_roles where user_id = auth.uid()) <> 'admin' then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_role not in ('admin','editor','viewer') then
    raise exception 'invalid role' using errcode = '22023';
  end if;
  insert into public.auth_allowlist (email, default_role, added_by, note)
    values (lower(p_email), p_role::public.waypoint_user_role, auth.uid(), p_note)
    on conflict (email)
      do update set default_role = excluded.default_role,
                    note = excluded.note,
                    added_by = excluded.added_by,
                    added_at = now();
end;
$$;

--
-- Name: admin_list_allowlist(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_allowlist() RETURNS TABLE(email text, default_role text, added_by uuid, added_by_email text, added_at timestamp with time zone, note text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if (select role::text from public.user_roles where user_id = auth.uid()) <> 'admin' then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  return query
    select a.email, a.default_role::text, a.added_by,
           ub.email::text, a.added_at, a.note
    from public.auth_allowlist a
    left join auth.users ub on ub.id = a.added_by
    order by a.added_at desc;
end;
$$;

--
-- Name: admin_list_users(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_users() RETURNS TABLE(user_id uuid, email text, role text, created_at timestamp with time zone, last_sign_in_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if (
    select ur.role::text
      from public.user_roles ur
      where ur.user_id = auth.uid()
  ) <> 'admin' then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  return query
    select
      u.id                          as user_id,
      u.email::text                 as email,
      coalesce(ur.role::text, 'viewer') as role,
      u.created_at                  as created_at,
      u.last_sign_in_at             as last_sign_in_at
    from auth.users u
    left join public.user_roles ur on ur.user_id = u.id
    order by u.created_at;
end;
$$;

--
-- Name: admin_remove_from_allowlist(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_remove_from_allowlist(p_email text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if (select role::text from public.user_roles where user_id = auth.uid()) <> 'admin' then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  delete from public.auth_allowlist where lower(email) = lower(p_email);
end;
$$;

--
-- Name: admin_remove_user(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_remove_user(p_email text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  target_id uuid;
begin
  if (select role::text from public.user_roles where user_id = auth.uid()) <> 'admin' then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select id into target_id from auth.users where lower(email) = lower(p_email);
  if target_id is null then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if target_id = auth.uid() then
    raise exception 'cannot remove your own account' using errcode = '22023';
  end if;
  delete from auth.users where id = target_id;
end;
$$;

--
-- Name: admin_set_user_role(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_user_role(p_email text, p_role text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  target_id uuid;
  caller_role text;
begin
  caller_role := (select role::text from public.user_roles where user_id = auth.uid());
  if caller_role <> 'admin' then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_role not in ('admin','editor','viewer') then
    raise exception 'invalid role: %', p_role using errcode = '22023';
  end if;
  select id into target_id from auth.users where lower(email) = lower(p_email);
  if target_id is null then
    raise exception 'user with email % not found', p_email using errcode = 'P0002';
  end if;
  insert into public.user_roles (user_id, role, updated_at)
    values (target_id, p_role::public.waypoint_user_role, now())
    on conflict (user_id)
      do update set role = excluded.role, updated_at = now();
end;
$$;

--
-- Name: current_user_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_user_role() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(
    (select role::text from public.user_roles where user_id = auth.uid()),
    'viewer'
  );
$$;

--
-- Name: get_all_narratives_brief(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_all_narratives_brief() RETURNS TABLE(id text, kind text, fiscal_year integer, mission_description text, title text)
    LANGUAGE sql STABLE
    AS $$
  SELECT n.pe_id, 'pe'::text, n.fiscal_year,
         LEFT(COALESCE(n.mission_description, ''), 50000),
         COALESCE(p.title, n.pe_id)
  FROM public.pe_narratives n
  LEFT JOIN public.budget_pes p ON p.id = n.pe_id
  UNION ALL
  SELECT n.sag_id, 'sag'::text, n.fiscal_year,
         LEFT(COALESCE(n.mission_description, ''), 50000),
         COALESCE(s.sag_title, n.sag_id)
  FROM public.om_sag_narratives n
  LEFT JOIN public.budget_om_sags s ON s.id = n.sag_id
  UNION ALL
  SELECT n.proc_line_id, 'proc'::text, n.fiscal_year,
         LEFT(COALESCE(n.mission_description, ''), 50000),
         COALESCE(p.title, n.proc_line_id)
  FROM public.proc_line_narratives n
  LEFT JOIN public.budget_pes p ON p.id = n.proc_line_id
$$;

--
-- Name: get_all_narratives_brief(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_all_narratives_brief(p_offset integer DEFAULT 0, p_limit integer DEFAULT 5000) RETURNS TABLE(id text, kind text, fiscal_year integer, mission_description text, title text)
    LANGUAGE sql STABLE
    AS $$
  WITH all_rows AS (
    SELECT n.pe_id::text AS id, 'pe'::text AS kind, n.fiscal_year,
           LEFT(COALESCE(n.mission_description, ''), 50000) AS mission_description,
           COALESCE(p.title, n.pe_id) AS title
    FROM public.pe_narratives n
    LEFT JOIN public.budget_pes p ON p.id = n.pe_id
    UNION ALL
    SELECT n.sag_id::text, 'sag'::text, n.fiscal_year,
           LEFT(COALESCE(n.mission_description, ''), 50000),
           COALESCE(s.sag_title, n.sag_id)
    FROM public.om_sag_narratives n
    LEFT JOIN public.budget_om_sags s ON s.id = n.sag_id
    UNION ALL
    SELECT n.proc_line_id::text, 'proc'::text, n.fiscal_year,
           LEFT(COALESCE(n.mission_description, ''), 50000),
           COALESCE(p.title, n.proc_line_id)
    FROM public.proc_line_narratives n
    LEFT JOIN public.budget_pes p ON p.id = n.proc_line_id
  )
  SELECT * FROM all_rows
  ORDER BY kind, id, fiscal_year
  OFFSET COALESCE(p_offset, 0)
  LIMIT COALESCE(p_limit, 5000);
$$;

--
-- Name: get_narrative_diff_set(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_narrative_diff_set(p_year_a integer, p_year_b integer) RETURNS TABLE(pe_id text, changed boolean)
    LANGUAGE sql STABLE
    AS $$
  SELECT a.pe_id, (a.content_hash IS DISTINCT FROM b.content_hash)
  FROM pe_narratives a
  JOIN pe_narratives b ON a.pe_id = b.pe_id
  WHERE a.fiscal_year = p_year_a AND b.fiscal_year = p_year_b
$$;

--
-- Name: get_narrative_for_pe(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_narrative_for_pe(p_pe_id text, p_year integer) RETURNS TABLE(pe_id text, fiscal_year integer, mission_description text, justification text, accomplishments text, planned_program text, performance_metrics text, other_program_funding text, raw_text text, content_hash text, section_hashes jsonb, source_pdf text, source_page integer)
    LANGUAGE sql STABLE
    AS $$
  SELECT pe_id, fiscal_year, mission_description, justification,
         accomplishments, planned_program, performance_metrics,
         other_program_funding, raw_text, content_hash, section_hashes,
         source_pdf, source_page
  FROM public.pe_narratives
  WHERE pe_id = p_pe_id AND fiscal_year = p_year
  LIMIT 1
$$;

--
-- Name: get_om_sag_narrative(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_om_sag_narrative(p_sag_id text, p_year integer) RETURNS TABLE(sag_id text, fiscal_year integer, mission_description text, justification text, source_pdf text, source_page_description integer, source_page_amount integer, content_hash text, ingested_at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
  SELECT sag_id, fiscal_year, mission_description, justification,
         source_pdf, source_page_description, source_page_amount,
         content_hash, ingested_at
  FROM public.om_sag_narratives
  WHERE sag_id = p_sag_id AND fiscal_year = p_year
  LIMIT 1
$$;

--
-- Name: FUNCTION get_om_sag_narrative(p_sag_id text, p_year integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_om_sag_narrative(p_sag_id text, p_year integer) IS 'v188: Returns a single om_sag_narratives row for the given (sag_id, year). Mirrors get_narrative_for_pe shape for dashboard drawer rendering.';

--
-- Name: get_pes_for_year(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_pes_for_year(p_year integer) RETURNS TABLE(id text, title text, appropriation_id text, owning_org_id text, fiscal_year integer, request_amount numeric, prior_year_amount numeric, enacted_amount numeric, fy27_amount numeric, fy28_amount numeric, fy29_amount numeric, fy30_amount numeric, cost_to_complete numeric, total_cost numeric, r1_line integer, source_pdf text, source_page integer, ba text, service text, is_priority boolean, description text, raw_source jsonb)
    LANGUAGE sql STABLE
    AS $_$
  -- (a) FY27 branch: budget_pes
  SELECT
    bp.id::text,
    COALESCE(o.title, bp.title)::text AS title,
    bp.appropriation_id::text,
    bp.owning_org_id::text,
    p_year::integer AS fiscal_year,
    COALESCE(bp.fy27_total_amount, bp.fy27_amount, bp.fy27_request_amount, 0)::numeric AS request_amount,
    COALESCE(bp.fy25_actual_amount, bp.prior_year_amount)::numeric AS prior_year_amount,
    COALESCE(bp.fy26_enacted_amount, bp.enacted_amount)::numeric AS enacted_amount,
    COALESCE(bp.fy27_total_amount, bp.fy27_amount)::numeric AS fy27_amount,
    bp.fy28_amount::numeric,
    bp.fy29_amount::numeric,
    bp.fy30_amount::numeric,
    bp.cost_to_complete::numeric,
    bp.total_cost::numeric,
    bp.r1_line::integer,
    COALESCE(bp.fy27_source_pdf, bp.source_pdf)::text AS source_pdf,
    -- v56c: source_page from pe_narratives (RDT&E) or proc_line_narratives (procurement) for FY27.
    COALESCE(n.source_page, pln.source_page_description, pln.source_page_amount)::integer AS source_page,
    ba.ba::text AS ba,
    CASE
      WHEN bp.appropriation_id LIKE '%_army_%'  OR bp.appropriation_id LIKE 'rdte_army%' OR bp.appropriation_id LIKE 'proc_army%' THEN 'Army'
      WHEN bp.appropriation_id LIKE '%_af_%'    OR bp.appropriation_id LIKE 'rdte_af%'   OR bp.appropriation_id LIKE 'proc_af%'   THEN 'Air Force'
      WHEN bp.appropriation_id LIKE '%_navy_%'  OR bp.appropriation_id LIKE 'rdte_navy%' OR bp.appropriation_id LIKE 'proc_navy%' THEN 'Navy'
      WHEN bp.appropriation_id LIKE '%_sf_%'    OR bp.appropriation_id LIKE 'rdte_sf%'   OR bp.appropriation_id LIKE 'proc_sf%'   THEN 'Space Force'
      WHEN bp.appropriation_id LIKE '%_mc_%'    OR bp.appropriation_id LIKE 'proc_mc%' OR bp.appropriation_id LIKE '%marines%' OR bp.appropriation_id LIKE 'proc_marines%' THEN 'Marines'
      WHEN bp.appropriation_id LIKE '%_dw_%'    OR bp.appropriation_id LIKE 'rdte_dw%'   OR bp.appropriation_id LIKE 'proc_dw%'   THEN 'Defense-Wide'
      WHEN bp.appropriation_id LIKE '%_ote_%'   OR bp.appropriation_id LIKE 'rdte_ote%'                                            THEN 'OT&E'
      ELSE NULL
    END::text AS service,
    COALESCE(bp.is_priority, false) AS is_priority,
    COALESCE(bp.fy27_mission_description, bp.description)::text AS description,
    bp.raw_source
  FROM public.budget_pes bp
  LEFT JOIN public.budget_appropriations ba ON ba.id = bp.appropriation_id
  LEFT JOIN public.pe_title_overrides o ON o.pe_id = bp.id AND o.fiscal_year = p_year
  LEFT JOIN public.pe_narratives n ON n.pe_id = bp.id AND n.fiscal_year = p_year
  LEFT JOIN public.proc_line_narratives pln ON pln.proc_line_id = bp.id AND pln.fiscal_year = p_year
  WHERE p_year = 2027
    AND COALESCE(bp.fy27_total_amount, bp.fy27_amount, bp.fy27_request_amount) IS NOT NULL

  UNION ALL

  -- (b) FY26 RDT&E branch
  SELECT
    p.pe_id,
    COALESCE(o.title, b.title, p.title) AS title,
    CASE
      WHEN p.pe_id ~ 'SF$'                THEN 'rdte_sf_ba'   || COALESCE(p.ba, '1')
      WHEN p.pe_id ~ 'F$'                 THEN 'rdte_af_ba'   || COALESCE(p.ba, '1')
      WHEN p.pe_id ~ 'A$'                 THEN 'rdte_army_ba' || COALESCE(p.ba, '1')
      WHEN p.pe_id ~ '[NM]$'              THEN 'rdte_navy_ba' || COALESCE(p.ba, '1')
      WHEN p.service = 'Defense-Wide'     THEN 'rdte_dw_ba'   || COALESCE(p.ba, '1')
      ELSE 'rdte_dw_ba' || COALESCE(p.ba, '1')
    END AS appropriation_id,
    b.owning_org_id::text AS owning_org_id,
    p.fiscal_year,
    COALESCE(
      b.fy27_total_amount, b.fy27_amount, b.fy27_request_amount,
      CASE
        WHEN p.fiscal_year = 2026 THEN p.fydp_yr1 * 1000000
        WHEN p.fiscal_year = 2027 THEN p.request_amount * 1000000
        ELSE NULL
      END
    )::numeric AS request_amount,
    COALESCE(b.fy25_actual_amount, p.prior_year_actual * 1000000)::numeric AS prior_year_amount,
    COALESCE(b.fy26_enacted_amount, p.current_year_enacted * 1000000)::numeric AS enacted_amount,
    COALESCE(
      b.fy27_total_amount, b.fy27_amount,
      CASE
        WHEN p.fiscal_year = 2026 THEN p.fydp_yr1 * 1000000
        WHEN p.fiscal_year = 2027 THEN p.request_amount * 1000000
        ELSE NULL
      END
    )::numeric AS fy27_amount,
    COALESCE(b.fy28_amount,
      CASE WHEN p.fiscal_year = 2026 THEN p.fydp_yr2 * 1000000
           WHEN p.fiscal_year = 2027 THEN p.fydp_yr1 * 1000000
           ELSE NULL END)::numeric AS fy28_amount,
    COALESCE(b.fy29_amount,
      CASE WHEN p.fiscal_year = 2026 THEN p.fydp_yr3 * 1000000
           WHEN p.fiscal_year = 2027 THEN p.fydp_yr2 * 1000000
           ELSE NULL END)::numeric AS fy29_amount,
    COALESCE(b.fy30_amount,
      CASE WHEN p.fiscal_year = 2026 THEN p.fydp_yr4 * 1000000
           WHEN p.fiscal_year = 2027 THEN p.fydp_yr3 * 1000000
           ELSE NULL END)::numeric AS fy30_amount,
    b.cost_to_complete::numeric,
    b.total_cost::numeric,
    b.r1_line::integer,
    COALESCE(b.source_pdf, p.source_pdf) AS source_pdf,
    n.source_page::integer AS source_page,
    p.ba, p.service,
    COALESCE(b.is_priority, false),
    n.mission_description,
    p.raw_source
  FROM public.pe_budget_years p
  LEFT JOIN public.budget_pes b      ON b.id = p.pe_id
  LEFT JOIN public.pe_narratives n   ON n.pe_id = p.pe_id AND n.fiscal_year = p.fiscal_year
  LEFT JOIN public.pe_title_overrides o ON o.pe_id = p.pe_id AND o.fiscal_year = p.fiscal_year
  WHERE p.fiscal_year = p_year
    AND p.appropriation = 'RDTE'
    AND p.pe_id NOT LIKE 'P\_%' ESCAPE '\'
    AND (
      p_year <> 2027
      OR NOT EXISTS (
        SELECT 1 FROM public.budget_pes bp2
         WHERE bp2.id = p.pe_id
           AND COALESCE(bp2.fy27_total_amount, bp2.fy27_amount, bp2.fy27_request_amount) IS NOT NULL
      )
    )

  UNION ALL

  -- (c) FY26 procurement branch
  SELECT
    bp.id::text,
    COALESCE(o.title, bp.title)::text AS title,
    bp.appropriation_id::text,
    bp.owning_org_id::text,
    p_year::integer AS fiscal_year,
    COALESCE(bp.fy27_total_amount, bp.fy27_amount, bp.fy27_request_amount, bp.fy26_enacted_amount, 0)::numeric AS request_amount,
    COALESCE(bp.fy25_actual_amount, bp.prior_year_amount)::numeric AS prior_year_amount,
    COALESCE(bp.fy26_enacted_amount, bp.enacted_amount)::numeric AS enacted_amount,
    COALESCE(bp.fy27_total_amount, bp.fy27_amount)::numeric AS fy27_amount,
    bp.fy28_amount::numeric,
    bp.fy29_amount::numeric,
    bp.fy30_amount::numeric,
    bp.cost_to_complete::numeric,
    bp.total_cost::numeric,
    bp.r1_line::integer,
    bp.source_pdf::text,
    COALESCE(pln.source_page_description, pln.source_page_amount)::integer AS source_page,
    ba.ba::text AS ba,
    CASE
      WHEN bp.appropriation_id LIKE 'proc_army%' THEN 'Army'
      WHEN bp.appropriation_id LIKE 'proc_af%'   THEN 'Air Force'
      WHEN bp.appropriation_id LIKE 'proc_navy%' THEN 'Navy'
      WHEN bp.appropriation_id LIKE 'proc_sf%'   THEN 'Space Force'
      WHEN bp.appropriation_id LIKE 'proc_mc%' OR bp.appropriation_id LIKE 'proc_marines%' THEN 'Marines'
      WHEN bp.appropriation_id LIKE 'proc_dw%' OR bp.appropriation_id LIKE 'proc_cbdp%' OR bp.appropriation_id LIKE 'proc_gd%' THEN 'Defense-Wide'
      ELSE NULL
    END::text AS service,
    COALESCE(bp.is_priority, false) AS is_priority,
    bp.description::text AS description,
    bp.raw_source
  FROM public.budget_pes bp
  LEFT JOIN public.budget_appropriations ba ON ba.id = bp.appropriation_id
  LEFT JOIN public.pe_title_overrides o ON o.pe_id = bp.id AND o.fiscal_year = p_year
  LEFT JOIN public.proc_line_narratives pln ON pln.proc_line_id = bp.id AND pln.fiscal_year = p_year
  WHERE p_year <> 2027
    AND bp.id LIKE 'P\_%' ESCAPE '\'
    AND bp.fy26_enacted_amount IS NOT NULL
$_$;

--
-- Name: get_proc_line_narrative(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_proc_line_narrative(p_proc_line_id text, p_year integer) RETURNS TABLE(proc_line_id text, fiscal_year integer, mission_description text, justification text, source_pdf text, source_page_description integer, source_page_amount integer, content_hash text, ingested_at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
  SELECT proc_line_id, fiscal_year, mission_description, justification,
         source_pdf, source_page_description, source_page_amount,
         content_hash, ingested_at
  FROM public.proc_line_narratives
  WHERE proc_line_id = p_proc_line_id AND fiscal_year = p_year
  LIMIT 1
$$;

--
-- Name: FUNCTION get_proc_line_narrative(p_proc_line_id text, p_year integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_proc_line_narrative(p_proc_line_id text, p_year integer) IS 'v188: Returns a single proc_line_narratives row for the given (proc_line_id, year). Mirrors get_narrative_for_pe shape for dashboard drawer rendering.';

--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_role public.waypoint_user_role;
  v_count int;
begin
  v_count := (select count(*) from public.user_roles);

  if v_count = 0 then
    v_role := 'admin'::public.waypoint_user_role;
  else
    select default_role into v_role
      from public.auth_allowlist
      where lower(email) = lower(new.email);
    if v_role is null then
      raise exception 'Email % is not on the Waypoint allowlist. Ask an admin to add you.', new.email
        using errcode = '22023';
    end if;
  end if;

  insert into public.user_roles (user_id, role)
    values (new.id, v_role)
    on conflict (user_id) do nothing;
  return new;
end;
$$;

--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$ SELECT public.user_role() = 'admin'; $$;

--
-- Name: is_editor(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_editor() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$ SELECT public.user_role() IN ('editor', 'admin'); $$;

--
-- Name: is_email_allowed(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_email_allowed(p_email text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.auth_allowlist
    WHERE lower(email) = lower(p_email)
  );
$$;

--
-- Name: scout_fuzzy_contacts(text, text, real, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.scout_fuzzy_contacts(q_name text, q_office_id text DEFAULT NULL::text, threshold real DEFAULT 0.45, max_rows integer DEFAULT 5) RETURNS TABLE(contact_id text, full_name text, rank text, title text, email text, phone text, office_ids jsonb, similarity real)
    LANGUAGE sql STABLE
    AS $$
  select
    c.id,
    btrim(coalesce(c."firstName", '') || ' ' || coalesce(c."lastName", '')),
    c.rank,
    c.title,
    c.email,
    c.phone,
    c."officeIds",
    similarity(
      lower(btrim(coalesce(c."firstName", '') || ' ' || coalesce(c."lastName", ''))),
      lower(coalesce(q_name, ''))
    ) as sim
  from contacts c
  where
    similarity(
      lower(btrim(coalesce(c."firstName", '') || ' ' || coalesce(c."lastName", ''))),
      lower(coalesce(q_name, ''))
    ) >= threshold
    and (
      q_office_id is null
      or (c."officeIds" is not null and c."officeIds" ? q_office_id)
    )
  order by sim desc
  limit max_rows;
$$;

--
-- Name: scout_fuzzy_offices(text, real, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.scout_fuzzy_offices(q text, threshold real DEFAULT 0.30, max_rows integer DEFAULT 8) RETURNS TABLE(office_id text, name text, service text, similarity real)
    LANGUAGE sql STABLE
    AS $$
  select
    o.id,
    o.name,
    coalesce(o.service, ''),
    greatest(
      similarity(lower(coalesce(o.name, '')), lower(q)),
      similarity(lower(coalesce(o."fullName", '')), lower(q)),
      similarity(lower(coalesce(o.id, '')),   lower(q))
    ) as sim
  from offices o
  where
    similarity(lower(coalesce(o.name, '')),     lower(q)) >= threshold
    or similarity(lower(coalesce(o."fullName", '')), lower(q)) >= threshold
    or similarity(lower(coalesce(o.id, '')),    lower(q)) >= threshold
  order by sim desc
  limit max_rows;
$$;

--
-- Name: scout_jobs_append_events(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.scout_jobs_append_events(j uuid, evts jsonb) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
  total int;
begin
  update scout_jobs
     set events = events || evts
   where id = j
   returning jsonb_array_length(events) into total;
  return coalesce(total, 0);
end;
$$;

--
-- Name: scout_jobs_touch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.scout_jobs_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;

--
-- Name: user_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_role() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT role FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: apollo_phone_webhook_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apollo_phone_webhook_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    apollo_id text NOT NULL,
    finding_id uuid,
    search_id uuid,
    sanitized_number text,
    raw_number text,
    confidence_cd text,
    type_cd text,
    status text,
    raw_payload jsonb,
    patched boolean DEFAULT false NOT NULL,
    patch_reason text
);

--
-- Name: auth_allowlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_allowlist (
    email text NOT NULL,
    default_role public.waypoint_user_role DEFAULT 'viewer'::public.waypoint_user_role NOT NULL,
    added_by uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    note text
);

--
-- Name: budget_appropriations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_appropriations (
    id text NOT NULL,
    title text NOT NULL,
    account text NOT NULL,
    ba text,
    ba_name text,
    display_color text
);

--
-- Name: budget_om_sags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_om_sags (
    id text NOT NULL,
    sag_short_code text,
    sag_title text NOT NULL,
    defense_wide_org text,
    appropriation_id text,
    budget_activity text,
    owning_org_id text,
    fiscal_year integer DEFAULT 2026 NOT NULL,
    fy24_enacted numeric DEFAULT 0,
    fy25_request numeric DEFAULT 0,
    fy25_cong_amt numeric DEFAULT 0,
    fy25_cong_pct numeric,
    fy25_current numeric DEFAULT 0,
    fy26_estimate numeric DEFAULT 0,
    description text,
    sub_narratives jsonb DEFAULT '[]'::jsonb,
    subactivities jsonb DEFAULT '[]'::jsonb,
    personnel jsonb DEFAULT '{}'::jsonb,
    source_pdf text,
    source_page_start integer,
    source_page_end integer,
    is_synthetic boolean DEFAULT false,
    raw_source jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    is_priority boolean DEFAULT false NOT NULL,
    fy25_actual numeric,
    fy26_request numeric,
    fy26_cong_amt numeric,
    fy26_cong_pct numeric,
    fy26_current numeric,
    fy27_estimate numeric,
    fy27_subactivities jsonb,
    fy27_sub_narratives jsonb,
    fy27_personnel jsonb,
    fy27_source_pdf text,
    fy27_mandatory_amount bigint,
    CONSTRAINT budget_om_sags_fy27_mand_nonneg CHECK (((fy27_mandatory_amount IS NULL) OR (fy27_mandatory_amount >= 0)))
);

--
-- Name: COLUMN budget_om_sags.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.budget_om_sags.description IS 'Phase 7 (v176): per-SAG narrative for dashboard expand-arrow drawer. Sourced from OP-5 "I. Description of Operations Financed". Plain text. Co-located with fy27_source_pdf.';

--
-- Name: COLUMN budget_om_sags.fy27_mandatory_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.budget_om_sags.fy27_mandatory_amount IS 'FY27 mandatory funding (PL 119-21 / reconciliation), in raw dollars. NULL means no mandatory or unknown. Source: FY27 PB O-1 Mandatory column.';

--
-- Name: budget_orgs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_orgs (
    id text NOT NULL,
    name text NOT NULL,
    parent_id text,
    aliases jsonb DEFAULT '[]'::jsonb,
    service text,
    notes text
);

--
-- Name: budget_pes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_pes (
    id text NOT NULL,
    title text NOT NULL,
    appropriation_id text NOT NULL,
    owning_org_id text,
    fiscal_year integer NOT NULL,
    request_amount numeric DEFAULT 0,
    prior_year_amount numeric DEFAULT 0,
    enacted_amount numeric DEFAULT 0,
    narrative_url text,
    raw_source jsonb DEFAULT '{}'::jsonb,
    description text,
    fy27_amount numeric,
    fy28_amount numeric,
    fy29_amount numeric,
    fy30_amount numeric,
    cost_to_complete numeric,
    total_cost numeric,
    r1_line integer,
    source_pdf text,
    defense_wide_org text,
    is_priority boolean DEFAULT false NOT NULL,
    fy25_actual_amount numeric,
    fy26_enacted_amount numeric,
    fy27_request_amount numeric,
    fy27_base_amount numeric,
    fy27_ooc_amount numeric,
    fy27_total_amount numeric,
    fy31_amount numeric,
    fy27_mission_description text,
    fy27_source_pdf text
);

--
-- Name: COLUMN budget_pes.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.budget_pes.description IS 'Phase 7 (v176): per-PE narrative for dashboard expand-arrow drawer. Sourced from R-2 (RDT&E) Mission Description / P-40 (procurement) Item Justification. Multi-paragraph plain text, 200-30000 chars. Co-located with source_pdf for hyperlink resolution.';

--
-- Name: pe_budget_years; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_budget_years (
    pe_id text NOT NULL,
    fiscal_year integer NOT NULL,
    appropriation text NOT NULL,
    service text,
    ba text,
    title text,
    prior_year_actual numeric,
    current_year_enacted numeric,
    request_amount numeric,
    fydp_yr1 numeric,
    fydp_yr2 numeric,
    fydp_yr3 numeric,
    fydp_yr4 numeric,
    source_pdf text,
    source_page integer,
    raw_source jsonb DEFAULT '{}'::jsonb,
    ingested_at timestamp with time zone DEFAULT now()
);

--
-- Name: budget_pes_compat; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.budget_pes_compat AS
 SELECT pe_id AS id,
    title,
    appropriation AS appropriation_id,
    NULL::text AS owning_org_id,
    fiscal_year,
    request_amount,
    prior_year_actual AS prior_year_amount,
    current_year_enacted AS enacted_amount,
    NULL::text AS narrative_url,
    raw_source
   FROM public.pe_budget_years pby
  WHERE (appropriation = 'RDTE'::text);

--
-- Name: budget_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_projects (
    id text NOT NULL,
    pe_id text NOT NULL,
    project_number text NOT NULL,
    title text,
    request_amount numeric DEFAULT 0,
    narrative text,
    fy26_amount numeric,
    fy27_amount numeric,
    fy28_amount numeric,
    fy29_amount numeric,
    fy30_amount numeric,
    prior_year_amount numeric,
    fiscal_year integer
);

--
-- Name: budget_topline_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_topline_lines (
    id text NOT NULL,
    appropriation_id text,
    service text,
    component text,
    account_type text NOT NULL,
    ba text,
    ba_name text,
    title text NOT NULL,
    fy24_actual numeric,
    fy25_enacted numeric,
    fy26_disc numeric,
    fy26_recon numeric,
    fy26_total numeric,
    narrative text,
    source_pdf text,
    source_page_start integer,
    source_page_end integer,
    raw_source jsonb,
    is_priority boolean DEFAULT false,
    owner text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    fy27_disc numeric,
    fy27_mand numeric,
    fy27_total numeric,
    CONSTRAINT budget_topline_lines_fy27_mand_nonneg CHECK (((fy27_mand IS NULL) OR (fy27_mand >= (0)::numeric)))
);

--
-- Name: COLUMN budget_topline_lines.fy27_disc; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.budget_topline_lines.fy27_disc IS 'FY27 discretionary request in raw dollars. Authoritative source: FY27 PB M-1 / C-1 / O-1 / R-1 / P-1 columns, depending on account_type. Populated v159+.';

--
-- Name: COLUMN budget_topline_lines.fy27_mand; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.budget_topline_lines.fy27_mand IS 'FY27 mandatory request in raw dollars. NULL means not yet populated. Zero means confirmed zero from source. Constraint: NULL or >=0.';

--
-- Name: COLUMN budget_topline_lines.fy27_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.budget_topline_lines.fy27_total IS 'FY27 total = fy27_disc + fy27_mand. Reimbursables offset rows carry negative fy27_disc (and zero fy27_mand) to mirror existing FY26 negative-offset pattern.';

--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id text NOT NULL,
    "firstName" text,
    "lastName" text,
    rank text,
    title text,
    unit text,
    branch text,
    source text,
    lead text,
    email text,
    phone text,
    "officeIds" jsonb DEFAULT '[]'::jsonb,
    notes text,
    champion boolean DEFAULT false,
    office_ids_new uuid[] DEFAULT '{}'::uuid[],
    callsign text,
    "linkedinUrl" text,
    legislator_bioguide_id text
);

--
-- Name: COLUMN contacts.legislator_bioguide_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contacts.legislator_bioguide_id IS 'Optional FK to hill_members.bioguide_id. Set when a contact is the staffer/aide of a sitting senator or representative. Independent of officeIds.';

--
-- Name: hill_committee_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hill_committee_memberships (
    bioguide_id text NOT NULL,
    thomas_id text NOT NULL,
    role text,
    rank smallint,
    side text
);

--
-- Name: TABLE hill_committee_memberships; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.hill_committee_memberships IS 'Junction: which member sits on which committee, with role + seniority. Wiped and reseeded on every sync.';

--
-- Name: hill_committees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hill_committees (
    thomas_id text NOT NULL,
    system_code text,
    name text NOT NULL,
    chamber text NOT NULL,
    type text,
    parent_thomas_id text,
    url text,
    jurisdiction text,
    is_priority boolean DEFAULT false,
    notes text,
    last_synced_at timestamp with time zone DEFAULT now(),
    show_on_summary boolean DEFAULT false,
    CONSTRAINT hill_committees_chamber_check CHECK ((chamber = ANY (ARRAY['house'::text, 'senate'::text, 'joint'::text])))
);

--
-- Name: TABLE hill_committees; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.hill_committees IS 'Standing/select/special/joint committees + subcommittees. thomas_id matches unitedstates committee-membership feed; system_code matches Congress.gov.';

--
-- Name: hill_meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hill_meetings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    meeting_date date,
    title text,
    attendees text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    created_by text,
    CONSTRAINT hill_meetings_target_type_check CHECK ((target_type = ANY (ARRAY['member'::text, 'committee'::text])))
);

--
-- Name: TABLE hill_meetings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.hill_meetings IS 'Polymorphic engagement log: meetings, calls, briefings tied to either a Hill member (bioguide_id) or a committee/subcommittee (thomas_id).';

--
-- Name: hill_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hill_members (
    bioguide_id text NOT NULL,
    full_name text NOT NULL,
    first_name text,
    last_name text,
    chamber text NOT NULL,
    party text,
    state text,
    district smallint,
    term_start date,
    term_end date,
    office_address text,
    office_phone text,
    contact_form_url text,
    official_url text,
    photo_url text,
    bio_summary text,
    leadership_title text,
    is_priority boolean DEFAULT false,
    owner text,
    notes text,
    last_contacted date,
    tags text[] DEFAULT '{}'::text[],
    source text DEFAULT 'unitedstates+congress.gov'::text,
    last_synced_at timestamp with time zone DEFAULT now(),
    CONSTRAINT hill_members_chamber_check CHECK ((chamber = ANY (ARRAY['house'::text, 'senate'::text])))
);

--
-- Name: TABLE hill_members; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.hill_members IS 'Sitting US senators + representatives. Synced nightly from Congress.gov + unitedstates/congress-legislators. Outreach fields (is_priority, owner, notes, last_contacted, tags) are user-owned and not overwritten.';

--
-- Name: hill_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hill_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    submit_date date,
    title text,
    type text,
    status text,
    ask_amount bigint,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    created_by text,
    CONSTRAINT hill_requests_target_type_check CHECK ((target_type = ANY (ARRAY['member'::text, 'committee'::text])))
);

--
-- Name: TABLE hill_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.hill_requests IS 'Polymorphic legislative-ask log: NDAA marks, plus-ups, RFIs, approps requests tied to either a Hill member or committee.';

--
-- Name: letters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.letters (
    id text NOT NULL,
    name text,
    "officeId" text,
    "contactIds" jsonb DEFAULT '[]'::jsonb,
    status text,
    assignee text,
    notes text,
    office_id_new uuid,
    pdf_url text DEFAULT ''::text,
    pdf_filename text DEFAULT ''::text,
    letter_type text
);

--
-- Name: office_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.office_media (
    id text NOT NULL,
    office_id text NOT NULL,
    media_url text NOT NULL,
    filename text DEFAULT ''::text NOT NULL,
    caption text DEFAULT ''::text NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: offices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.offices (
    id text NOT NULL,
    name text,
    "fullName" text,
    service text,
    tier text,
    "dashboardCardId" text,
    notes text,
    location text,
    tags jsonb DEFAULT '[]'::jsonb,
    id_new uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid,
    also_reports_to uuid[] DEFAULT '{}'::uuid[],
    department text,
    roles text[] DEFAULT '{}'::text[],
    echelon text,
    show_on_dashboard boolean DEFAULT false,
    priority boolean DEFAULT false,
    short_description text,
    leadership jsonb DEFAULT '[]'::jsonb,
    dashboard_feeds text[] DEFAULT '{}'::text[],
    sort_order integer,
    dashboard_authorizes jsonb DEFAULT '[]'::jsonb,
    dashboard_group text,
    chamber text,
    party text,
    district text,
    committees jsonb DEFAULT '[]'::jsonb,
    location_city text,
    location_state text,
    location_country text,
    budget_org_id text,
    needs_mapping boolean DEFAULT false NOT NULL,
    created_via text,
    trl_min smallint,
    trl_max smallint,
    CONSTRAINT offices_trl_max_check CHECK (((trl_max IS NULL) OR ((trl_max >= 1) AND (trl_max <= 9)))),
    CONSTRAINT offices_trl_min_check CHECK (((trl_min IS NULL) OR ((trl_min >= 1) AND (trl_min <= 9)))),
    CONSTRAINT offices_trl_range_chk CHECK (((trl_min IS NULL) OR (trl_max IS NULL) OR (trl_max >= trl_min)))
);

--
-- Name: COLUMN offices.id_new; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.offices.id_new IS 'UUID identity. Promoted to primary key in a future migration.';

--
-- Name: COLUMN offices.parent_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.offices.parent_id IS 'Primary reporting parent. NULL for top-level orgs.';

--
-- Name: COLUMN offices.also_reports_to; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.offices.also_reports_to IS 'Secondary parents for matrix orgs (DIU, AFWERX, etc.).';

--
-- Name: COLUMN offices.department; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.offices.department IS 'Top-level grouping: AF / Army / Navy / Marines / SOCOM / OSD / Joint / Congress / Other.';

--
-- Name: COLUMN offices.roles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.offices.roles IS 'Tier classifications this org occupies. Usually 1 element; matrix orgs have multiple.';

--
-- Name: COLUMN offices.echelon; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.offices.echelon IS 'Optional org-chart echelon (MAJCOM, CORPS, DIVISION, ..., or 2a/2b/2c sub-tiers).';

--
-- Name: COLUMN offices.show_on_dashboard; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.offices.show_on_dashboard IS 'Whether this org renders as a Dashboard card.';

--
-- Name: COLUMN offices.priority; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.offices.priority IS 'Team-shared priority flag.';

--
-- Name: COLUMN offices.short_description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.offices.short_description IS 'Shown on the Dashboard card.';

--
-- Name: COLUMN offices.leadership; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.offices.leadership IS 'JSON array of leadership bullet strings.';

--
-- Name: COLUMN offices.dashboard_feeds; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.offices.dashboard_feeds IS 'Other offices this card feeds work to.';

--
-- Name: om_activity_years; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.om_activity_years (
    activity_code text NOT NULL,
    fiscal_year integer NOT NULL,
    service text,
    appropriation text,
    ba text,
    sag_short_code text,
    title text,
    prior_year_actual numeric,
    current_year_enacted numeric,
    request_amount numeric,
    fydp_yr1 numeric,
    fydp_yr2 numeric,
    fydp_yr3 numeric,
    fydp_yr4 numeric,
    narrative text,
    content_hash text,
    source_pdf text,
    source_page integer,
    ingested_at timestamp with time zone DEFAULT now()
);

--
-- Name: om_sag_narratives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.om_sag_narratives (
    sag_id text NOT NULL,
    fiscal_year integer NOT NULL,
    mission_description text,
    justification text,
    raw_text text,
    source_pdf text,
    source_page_description integer,
    source_page_amount integer,
    content_hash text,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT om_sag_narratives_fy_range CHECK (((fiscal_year >= 2020) AND (fiscal_year <= 2040))),
    CONSTRAINT om_sag_narratives_page_amount_pos CHECK (((source_page_amount IS NULL) OR (source_page_amount >= 1))),
    CONSTRAINT om_sag_narratives_page_description_pos CHECK (((source_page_description IS NULL) OR (source_page_description >= 1)))
);

--
-- Name: TABLE om_sag_narratives; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.om_sag_narratives IS 'Phase 7 (v177): per-(SAG, fiscal_year) narrative + source-PDF page anchors. One row per SAG per fiscal year (FY26 + FY27 coexist). Mirrors pe_narratives shape, plus a second page column because OP-5 narratives routinely span 10+ pages between description start and the cost-table GRAND TOTAL row.';

--
-- Name: COLUMN om_sag_narratives.mission_description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.om_sag_narratives.mission_description IS 'Primary narrative — OP-5 "I. Description of Operations Financed" body text.';

--
-- Name: COLUMN om_sag_narratives.justification; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.om_sag_narratives.justification IS 'Secondary narrative — reserved for OP-5 "IV. Performance Criteria" or similar alternate sections when present. Optional.';

--
-- Name: COLUMN om_sag_narratives.source_pdf; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.om_sag_narratives.source_pdf IS 'Relative filename of the source J-Book PDF (e.g. "Regular Army Operation and Maintenance Volume 1.pdf"). Used for hyperlink resolution.';

--
-- Name: COLUMN om_sag_narratives.source_page_description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.om_sag_narratives.source_page_description IS '1-indexed PDF physical page where the SAG narrative begins. Used in dashboard hyperlink for the description side of the drawer.';

--
-- Name: COLUMN om_sag_narratives.source_page_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.om_sag_narratives.source_page_amount IS '1-indexed PDF physical page where the SAG cost-table GRAND TOTAL row appears. Used for the "show me the number" hyperlink in the drawer.';

--
-- Name: pe_narratives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_narratives (
    pe_id text NOT NULL,
    fiscal_year integer NOT NULL,
    mission_description text,
    justification text,
    accomplishments text,
    planned_program text,
    performance_metrics text,
    other_program_funding text,
    raw_text text,
    content_hash text,
    section_hashes jsonb DEFAULT '{}'::jsonb,
    source_pdf text,
    source_page integer,
    ingested_at timestamp with time zone DEFAULT now()
);

--
-- Name: pe_office_link_dismissals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_office_link_dismissals (
    pe_id text NOT NULL,
    office_id text NOT NULL,
    dismissed_at timestamp with time zone DEFAULT now(),
    notes text
);

--
-- Name: pe_office_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_office_links (
    pe_id text NOT NULL,
    office_id text NOT NULL,
    link_type text DEFAULT 'primary'::text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT pe_office_links_link_type_chk CHECK ((link_type = ANY (ARRAY['primary'::text, 'shared'::text, 'user'::text, 'oversight'::text]))),
    CONSTRAINT pe_office_links_source_chk CHECK ((source = ANY (ARRAY['manual'::text, 'jbook_title'::text, 'jbook_desc'::text, 'rollup'::text, 'seed'::text])))
);

--
-- Name: pe_office_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_office_suggestions (
    pe_id text NOT NULL,
    office_id text NOT NULL,
    match_kind text NOT NULL,
    matched text,
    confidence numeric DEFAULT 0.5,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT pe_office_suggestions_kind_chk CHECK ((match_kind = ANY (ARRAY['title'::text, 'description'::text, 'project'::text])))
);

--
-- Name: pe_title_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pe_title_overrides (
    pe_id text NOT NULL,
    fiscal_year integer NOT NULL,
    title text NOT NULL,
    source_pdf text,
    source_page integer,
    evidence text,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: TABLE pe_title_overrides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pe_title_overrides IS 'v53 Track 2: per-year title overrides for PEs renamed between FY26 and FY27. Dashboard drawer toggle queries this to render the canonical title for the displayed year. Authoritative; if a row exists, it overrides budget_pes.title.';

--
-- Name: proc_line_narratives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proc_line_narratives (
    proc_line_id text NOT NULL,
    fiscal_year integer NOT NULL,
    mission_description text,
    justification text,
    raw_text text,
    source_pdf text,
    source_page_description integer,
    source_page_amount integer,
    content_hash text,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proc_line_narratives_fy_range CHECK (((fiscal_year >= 2020) AND (fiscal_year <= 2040))),
    CONSTRAINT proc_line_narratives_page_amount_pos CHECK (((source_page_amount IS NULL) OR (source_page_amount >= 1))),
    CONSTRAINT proc_line_narratives_page_description_pos CHECK (((source_page_description IS NULL) OR (source_page_description >= 1)))
);

--
-- Name: TABLE proc_line_narratives; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.proc_line_narratives IS 'Phase 7 (v177): per-(procurement-line, fiscal_year) narrative + source-PDF page anchors. proc_line_id references budget_pes(id) (procurement lines live alongside RDT&E PEs in budget_pes). Separate from pe_narratives because the source format is P-40 not R-2.';

--
-- Name: COLUMN proc_line_narratives.mission_description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.proc_line_narratives.mission_description IS 'Primary narrative — P-40 "Item Justification" body text.';

--
-- Name: COLUMN proc_line_narratives.justification; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.proc_line_narratives.justification IS 'Secondary narrative — reserved for explanatory P-40 sub-sections (quantity rationale, unit-cost notes). Optional.';

--
-- Name: COLUMN proc_line_narratives.source_pdf; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.proc_line_narratives.source_pdf IS 'Relative filename of the source procurement J-Book PDF.';

--
-- Name: COLUMN proc_line_narratives.source_page_description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.proc_line_narratives.source_page_description IS '1-indexed PDF physical page where the line item P-40 narrative begins.';

--
-- Name: COLUMN proc_line_narratives.source_page_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.proc_line_narratives.source_page_amount IS '1-indexed PDF physical page where the line item P-40 cost-table appears.';

--
-- Name: procurement_line_years; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.procurement_line_years (
    line_id text NOT NULL,
    fiscal_year integer NOT NULL,
    service text,
    appropriation text,
    appr_code text,
    ba text,
    line_number text,
    title text,
    quantity numeric,
    unit_cost numeric,
    prior_year_actual numeric,
    current_year_enacted numeric,
    request_amount numeric,
    fydp_yr1 numeric,
    fydp_yr2 numeric,
    fydp_yr3 numeric,
    fydp_yr4 numeric,
    narrative text,
    content_hash text,
    source_pdf text,
    source_page integer,
    ingested_at timestamp with time zone DEFAULT now()
);

--
-- Name: requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.requests (
    id text NOT NULL,
    "submitDate" text,
    type text,
    title text,
    "officeId" text,
    "askAmount" numeric,
    "fiscalYear" text,
    status text,
    "contactIds" jsonb DEFAULT '[]'::jsonb,
    notes text
);

--
-- Name: sag_office_link_dismissals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sag_office_link_dismissals (
    sag_id text NOT NULL,
    office_id text NOT NULL,
    dismissed_at timestamp with time zone DEFAULT now(),
    notes text
);

--
-- Name: sag_office_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sag_office_links (
    sag_id text NOT NULL,
    office_id text NOT NULL,
    link_type text DEFAULT 'primary'::text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT sag_office_links_link_type_chk CHECK ((link_type = ANY (ARRAY['primary'::text, 'shared'::text, 'user'::text, 'oversight'::text]))),
    CONSTRAINT sag_office_links_source_chk CHECK ((source = ANY (ARRAY['manual'::text, 'jbook_title'::text, 'jbook_desc'::text, 'rollup'::text, 'seed'::text])))
);

--
-- Name: sag_office_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sag_office_suggestions (
    sag_id text NOT NULL,
    office_id text NOT NULL,
    match_kind text NOT NULL,
    matched text,
    confidence numeric DEFAULT 0.5,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT sag_office_suggestions_kind_chk CHECK ((match_kind = ANY (ARRAY['title'::text, 'description'::text, 'sub_narrative'::text, 'org_alias'::text])))
);

--
-- Name: scout_findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scout_findings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    search_id uuid NOT NULL,
    full_name text,
    rank_or_title text,
    office_id text,
    proposed_office_name text,
    email text,
    email_confidence text,
    phone text,
    phone_confidence text,
    linkedin_url text,
    sources jsonb,
    notes text,
    status text DEFAULT 'draft'::text NOT NULL,
    matched_contact_id text,
    added_contact_id text,
    dismissed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    matched_contact_data jsonb,
    kind text DEFAULT 'contact'::text NOT NULL,
    data jsonb,
    apollo_id text,
    phone_pending boolean DEFAULT false NOT NULL,
    suggested_legislator_bioguide_id text,
    CONSTRAINT scout_findings_kind_check CHECK ((kind = ANY (ARRAY['contact'::text, 'office'::text, 'solicitation'::text])))
);

--
-- Name: COLUMN scout_findings.suggested_legislator_bioguide_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scout_findings.suggested_legislator_bioguide_id IS 'Inherited from the parent job. When the finding is committed to Waypoint, this becomes contacts.legislator_bioguide_id on the new contact.';

--
-- Name: scout_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scout_jobs (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    search_id uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    message text,
    created_by text,
    events jsonb DEFAULT '[]'::jsonb NOT NULL,
    total_turns integer DEFAULT 0 NOT NULL,
    total_tool_calls integer DEFAULT 0 NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    legislator_bioguide_id text
);

--
-- Name: COLUMN scout_jobs.legislator_bioguide_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scout_jobs.legislator_bioguide_id IS 'Auto-detected from the user message at job start. Pins Hill context for the duration of the job.';

--
-- Name: scout_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scout_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    search_id uuid NOT NULL,
    role text NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: scout_searches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scout_searches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL
);

--
-- Name: scout_tool_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scout_tool_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    search_id uuid NOT NULL,
    message_id uuid,
    tool_name text NOT NULL,
    arguments jsonb,
    result jsonb,
    result_summary text,
    latency_ms integer,
    cost_usd numeric(10,6) DEFAULT 0 NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: scout_url_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scout_url_cache (
    url text NOT NULL,
    title text,
    text text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: solicitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.solicitations (
    id text NOT NULL,
    title text,
    link text,
    "officeId" text,
    value numeric,
    "openDate" text,
    "dueDate" text,
    "awardDate" text,
    type text,
    phase text,
    topic text,
    tech jsonb DEFAULT '[]'::jsonb,
    status text,
    "contactIds" jsonb DEFAULT '[]'::jsonb,
    alignment numeric,
    notes text,
    office_id_new uuid,
    products jsonb DEFAULT '[]'::jsonb,
    is_priority boolean DEFAULT false NOT NULL,
    probability_pct integer DEFAULT 0 NOT NULL,
    owner text DEFAULT ''::text NOT NULL,
    estimated_value numeric GENERATED ALWAYS AS (((COALESCE(value, (0)::numeric) * (COALESCE(probability_pct, 0))::numeric) / 100.0)) STORED,
    pdf_url text,
    pdf_filename text,
    submission_pdf_url text,
    submission_pdf_filename text,
    CONSTRAINT solicitations_probability_pct_check CHECK (((probability_pct >= 0) AND (probability_pct <= 100)))
);

--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    role public.waypoint_user_role DEFAULT 'viewer'::public.waypoint_user_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: v_pe_office_resolved; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_pe_office_resolved AS
 SELECT l.pe_id,
    l.office_id,
    l.link_type,
    l.source,
    l.notes,
    l.created_at,
        CASE
            WHEN (d.pe_id IS NOT NULL) THEN true
            ELSE false
        END AS dismissed
   FROM (public.pe_office_links l
     LEFT JOIN public.pe_office_link_dismissals d ON (((d.pe_id = l.pe_id) AND (d.office_id = l.office_id))));

--
-- Name: v_sag_office_resolved; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_sag_office_resolved AS
 SELECT l.sag_id,
    l.office_id,
    l.link_type,
    l.source,
    l.notes,
    l.created_at,
        CASE
            WHEN (d.sag_id IS NOT NULL) THEN true
            ELSE false
        END AS dismissed
   FROM (public.sag_office_links l
     LEFT JOIN public.sag_office_link_dismissals d ON (((d.sag_id = l.sag_id) AND (d.office_id = l.office_id))));

--
-- Name: washops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.washops (
    id text NOT NULL,
    date text,
    type text,
    summary text,
    "officeIds" jsonb DEFAULT '[]'::jsonb,
    "contactIds" jsonb DEFAULT '[]'::jsonb,
    notes text,
    office_ids_new uuid[] DEFAULT '{}'::uuid[]
);

--
-- Name: apollo_phone_webhook_log apollo_phone_webhook_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apollo_phone_webhook_log
    ADD CONSTRAINT apollo_phone_webhook_log_pkey PRIMARY KEY (id);

--
-- Name: auth_allowlist auth_allowlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_allowlist
    ADD CONSTRAINT auth_allowlist_pkey PRIMARY KEY (email);

--
-- Name: budget_appropriations budget_appropriations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_appropriations
    ADD CONSTRAINT budget_appropriations_pkey PRIMARY KEY (id);

--
-- Name: budget_om_sags budget_om_sags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_om_sags
    ADD CONSTRAINT budget_om_sags_pkey PRIMARY KEY (id);

--
-- Name: budget_orgs budget_orgs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_orgs
    ADD CONSTRAINT budget_orgs_pkey PRIMARY KEY (id);

--
-- Name: budget_pes budget_pes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_pes
    ADD CONSTRAINT budget_pes_pkey PRIMARY KEY (id);

--
-- Name: budget_projects budget_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_projects
    ADD CONSTRAINT budget_projects_pkey PRIMARY KEY (id);

--
-- Name: budget_topline_lines budget_topline_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_topline_lines
    ADD CONSTRAINT budget_topline_lines_pkey PRIMARY KEY (id);

--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);

--
-- Name: hill_committee_memberships hill_committee_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hill_committee_memberships
    ADD CONSTRAINT hill_committee_memberships_pkey PRIMARY KEY (bioguide_id, thomas_id);

--
-- Name: hill_committees hill_committees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hill_committees
    ADD CONSTRAINT hill_committees_pkey PRIMARY KEY (thomas_id);

--
-- Name: hill_meetings hill_meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hill_meetings
    ADD CONSTRAINT hill_meetings_pkey PRIMARY KEY (id);

--
-- Name: hill_members hill_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hill_members
    ADD CONSTRAINT hill_members_pkey PRIMARY KEY (bioguide_id);

--
-- Name: hill_requests hill_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hill_requests
    ADD CONSTRAINT hill_requests_pkey PRIMARY KEY (id);

--
-- Name: letters letters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.letters
    ADD CONSTRAINT letters_pkey PRIMARY KEY (id);

--
-- Name: office_media office_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.office_media
    ADD CONSTRAINT office_media_pkey PRIMARY KEY (id);

--
-- Name: offices offices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offices
    ADD CONSTRAINT offices_pkey PRIMARY KEY (id);

--
-- Name: om_activity_years om_activity_years_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.om_activity_years
    ADD CONSTRAINT om_activity_years_pkey PRIMARY KEY (activity_code, fiscal_year);

--
-- Name: om_sag_narratives om_sag_narratives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.om_sag_narratives
    ADD CONSTRAINT om_sag_narratives_pkey PRIMARY KEY (sag_id, fiscal_year);

--
-- Name: pe_budget_years pe_budget_years_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_budget_years
    ADD CONSTRAINT pe_budget_years_pkey PRIMARY KEY (pe_id, fiscal_year, appropriation);

--
-- Name: pe_narratives pe_narratives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_narratives
    ADD CONSTRAINT pe_narratives_pkey PRIMARY KEY (pe_id, fiscal_year);

--
-- Name: pe_office_link_dismissals pe_office_link_dismissals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_link_dismissals
    ADD CONSTRAINT pe_office_link_dismissals_pkey PRIMARY KEY (pe_id, office_id);

--
-- Name: pe_office_links pe_office_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_links
    ADD CONSTRAINT pe_office_links_pkey PRIMARY KEY (pe_id, office_id);

--
-- Name: pe_office_suggestions pe_office_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_suggestions
    ADD CONSTRAINT pe_office_suggestions_pkey PRIMARY KEY (pe_id, office_id, match_kind);

--
-- Name: pe_title_overrides pe_title_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_title_overrides
    ADD CONSTRAINT pe_title_overrides_pkey PRIMARY KEY (pe_id, fiscal_year);

--
-- Name: proc_line_narratives proc_line_narratives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proc_line_narratives
    ADD CONSTRAINT proc_line_narratives_pkey PRIMARY KEY (proc_line_id, fiscal_year);

--
-- Name: procurement_line_years procurement_line_years_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.procurement_line_years
    ADD CONSTRAINT procurement_line_years_pkey PRIMARY KEY (line_id, fiscal_year);

--
-- Name: requests requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.requests
    ADD CONSTRAINT requests_pkey PRIMARY KEY (id);

--
-- Name: sag_office_link_dismissals sag_office_link_dismissals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sag_office_link_dismissals
    ADD CONSTRAINT sag_office_link_dismissals_pkey PRIMARY KEY (sag_id, office_id);

--
-- Name: sag_office_links sag_office_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sag_office_links
    ADD CONSTRAINT sag_office_links_pkey PRIMARY KEY (sag_id, office_id);

--
-- Name: sag_office_suggestions sag_office_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sag_office_suggestions
    ADD CONSTRAINT sag_office_suggestions_pkey PRIMARY KEY (sag_id, office_id, match_kind);

--
-- Name: scout_findings scout_findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_findings
    ADD CONSTRAINT scout_findings_pkey PRIMARY KEY (id);

--
-- Name: scout_jobs scout_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_jobs
    ADD CONSTRAINT scout_jobs_pkey PRIMARY KEY (id);

--
-- Name: scout_messages scout_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_messages
    ADD CONSTRAINT scout_messages_pkey PRIMARY KEY (id);

--
-- Name: scout_searches scout_searches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_searches
    ADD CONSTRAINT scout_searches_pkey PRIMARY KEY (id);

--
-- Name: scout_tool_calls scout_tool_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_tool_calls
    ADD CONSTRAINT scout_tool_calls_pkey PRIMARY KEY (id);

--
-- Name: scout_url_cache scout_url_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_url_cache
    ADD CONSTRAINT scout_url_cache_pkey PRIMARY KEY (url);

--
-- Name: solicitations solicitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.solicitations
    ADD CONSTRAINT solicitations_pkey PRIMARY KEY (id);

--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id);

--
-- Name: washops washops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.washops
    ADD CONSTRAINT washops_pkey PRIMARY KEY (id);

--
-- Name: apollo_phone_webhook_log_apollo_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apollo_phone_webhook_log_apollo_id_idx ON public.apollo_phone_webhook_log USING btree (apollo_id);

--
-- Name: apollo_phone_webhook_log_dedup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX apollo_phone_webhook_log_dedup_idx ON public.apollo_phone_webhook_log USING btree (apollo_id, sanitized_number) WHERE (sanitized_number IS NOT NULL);

--
-- Name: apollo_phone_webhook_log_finding_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apollo_phone_webhook_log_finding_id_idx ON public.apollo_phone_webhook_log USING btree (finding_id) WHERE (finding_id IS NOT NULL);

--
-- Name: budget_om_sags_is_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budget_om_sags_is_priority_idx ON public.budget_om_sags USING btree (is_priority) WHERE (is_priority = true);

--
-- Name: budget_pes_is_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budget_pes_is_priority_idx ON public.budget_pes USING btree (is_priority) WHERE (is_priority = true);

--
-- Name: idx_btl_acct; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_btl_acct ON public.budget_topline_lines USING btree (account_type);

--
-- Name: idx_btl_appr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_btl_appr ON public.budget_topline_lines USING btree (appropriation_id);

--
-- Name: idx_btl_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_btl_service ON public.budget_topline_lines USING btree (service);

--
-- Name: idx_budget_appr_title; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_appr_title ON public.budget_appropriations USING btree (title);

--
-- Name: idx_budget_om_sags_appr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_om_sags_appr ON public.budget_om_sags USING btree (appropriation_id);

--
-- Name: idx_budget_om_sags_dwo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_om_sags_dwo ON public.budget_om_sags USING btree (defense_wide_org);

--
-- Name: idx_budget_om_sags_fy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_om_sags_fy ON public.budget_om_sags USING btree (fiscal_year);

--
-- Name: idx_budget_om_sags_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_om_sags_org ON public.budget_om_sags USING btree (owning_org_id);

--
-- Name: idx_budget_orgs_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_orgs_parent ON public.budget_orgs USING btree (parent_id);

--
-- Name: idx_budget_pes_appr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_pes_appr ON public.budget_pes USING btree (appropriation_id);

--
-- Name: idx_budget_pes_description; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_pes_description ON public.budget_pes USING btree (((description IS NOT NULL)));

--
-- Name: idx_budget_pes_fy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_pes_fy ON public.budget_pes USING btree (fiscal_year);

--
-- Name: idx_budget_pes_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_pes_org ON public.budget_pes USING btree (owning_org_id);

--
-- Name: idx_budget_projects_pe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_projects_pe ON public.budget_projects USING btree (pe_id);

--
-- Name: idx_contacts_legislator_bioguide; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_legislator_bioguide ON public.contacts USING btree (legislator_bioguide_id) WHERE (legislator_bioguide_id IS NOT NULL);

--
-- Name: idx_hill_committees_chamber; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_committees_chamber ON public.hill_committees USING btree (chamber);

--
-- Name: idx_hill_committees_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_committees_parent ON public.hill_committees USING btree (parent_thomas_id);

--
-- Name: idx_hill_committees_show_on_summary; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_committees_show_on_summary ON public.hill_committees USING btree (show_on_summary) WHERE (show_on_summary = true);

--
-- Name: idx_hill_meetings_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_meetings_date ON public.hill_meetings USING btree (meeting_date DESC);

--
-- Name: idx_hill_meetings_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_meetings_target ON public.hill_meetings USING btree (target_type, target_id);

--
-- Name: idx_hill_members_chamber; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_members_chamber ON public.hill_members USING btree (chamber);

--
-- Name: idx_hill_members_party; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_members_party ON public.hill_members USING btree (party);

--
-- Name: idx_hill_members_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_members_priority ON public.hill_members USING btree (is_priority) WHERE (is_priority = true);

--
-- Name: idx_hill_members_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_members_state ON public.hill_members USING btree (state);

--
-- Name: idx_hill_memberships_bioguide; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_memberships_bioguide ON public.hill_committee_memberships USING btree (bioguide_id);

--
-- Name: idx_hill_memberships_thomas; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_memberships_thomas ON public.hill_committee_memberships USING btree (thomas_id);

--
-- Name: idx_hill_requests_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_requests_date ON public.hill_requests USING btree (submit_date DESC);

--
-- Name: idx_hill_requests_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hill_requests_target ON public.hill_requests USING btree (target_type, target_id);

--
-- Name: idx_offices_budget_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_offices_budget_org ON public.offices USING btree (budget_org_id);

--
-- Name: idx_scout_findings_sug_legislator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scout_findings_sug_legislator ON public.scout_findings USING btree (suggested_legislator_bioguide_id) WHERE (suggested_legislator_bioguide_id IS NOT NULL);

--
-- Name: idx_scout_jobs_legislator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scout_jobs_legislator ON public.scout_jobs USING btree (legislator_bioguide_id) WHERE (legislator_bioguide_id IS NOT NULL);

--
-- Name: office_media_office_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX office_media_office_id_idx ON public.office_media USING btree (office_id);

--
-- Name: offices_needs_mapping_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX offices_needs_mapping_idx ON public.offices USING btree (needs_mapping) WHERE (needs_mapping = true);

--
-- Name: offices_sort_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX offices_sort_order_idx ON public.offices USING btree (sort_order);

--
-- Name: om_appr_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX om_appr_idx ON public.om_activity_years USING btree (appropriation);

--
-- Name: om_sag_narratives_fy_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX om_sag_narratives_fy_idx ON public.om_sag_narratives USING btree (fiscal_year);

--
-- Name: om_sag_narratives_sag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX om_sag_narratives_sag_idx ON public.om_sag_narratives USING btree (sag_id);

--
-- Name: om_service_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX om_service_idx ON public.om_activity_years USING btree (service);

--
-- Name: om_year_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX om_year_idx ON public.om_activity_years USING btree (fiscal_year);

--
-- Name: pe_budget_years_appropriation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_budget_years_appropriation_idx ON public.pe_budget_years USING btree (appropriation);

--
-- Name: pe_budget_years_ba_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_budget_years_ba_idx ON public.pe_budget_years USING btree (ba);

--
-- Name: pe_budget_years_service_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_budget_years_service_idx ON public.pe_budget_years USING btree (service);

--
-- Name: pe_budget_years_year_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_budget_years_year_idx ON public.pe_budget_years USING btree (fiscal_year);

--
-- Name: pe_narratives_content_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_narratives_content_hash_idx ON public.pe_narratives USING btree (content_hash);

--
-- Name: pe_narratives_fts_2026_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_narratives_fts_2026_idx ON public.pe_narratives USING gin (to_tsvector('english'::regconfig, COALESCE(raw_text, ''::text))) WHERE (fiscal_year = 2026);

--
-- Name: pe_narratives_fts_2027_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_narratives_fts_2027_idx ON public.pe_narratives USING gin (to_tsvector('english'::regconfig, COALESCE(raw_text, ''::text))) WHERE (fiscal_year = 2027);

--
-- Name: pe_narratives_year_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_narratives_year_idx ON public.pe_narratives USING btree (fiscal_year);

--
-- Name: pe_office_dismissals_office_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_office_dismissals_office_idx ON public.pe_office_link_dismissals USING btree (office_id);

--
-- Name: pe_office_links_office_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_office_links_office_idx ON public.pe_office_links USING btree (office_id);

--
-- Name: pe_office_links_pe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_office_links_pe_idx ON public.pe_office_links USING btree (pe_id);

--
-- Name: pe_office_sugg_office_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_office_sugg_office_idx ON public.pe_office_suggestions USING btree (office_id);

--
-- Name: pe_office_sugg_pe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pe_office_sugg_pe_idx ON public.pe_office_suggestions USING btree (pe_id);

--
-- Name: proc_line_narratives_fy_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proc_line_narratives_fy_idx ON public.proc_line_narratives USING btree (fiscal_year);

--
-- Name: proc_line_narratives_pl_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proc_line_narratives_pl_idx ON public.proc_line_narratives USING btree (proc_line_id);

--
-- Name: proc_lines_apprcode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proc_lines_apprcode_idx ON public.procurement_line_years USING btree (appr_code);

--
-- Name: proc_lines_service_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proc_lines_service_idx ON public.procurement_line_years USING btree (service);

--
-- Name: proc_lines_year_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proc_lines_year_idx ON public.procurement_line_years USING btree (fiscal_year);

--
-- Name: sag_office_dismissals_office_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sag_office_dismissals_office_idx ON public.sag_office_link_dismissals USING btree (office_id);

--
-- Name: sag_office_links_office_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sag_office_links_office_idx ON public.sag_office_links USING btree (office_id);

--
-- Name: sag_office_links_sag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sag_office_links_sag_idx ON public.sag_office_links USING btree (sag_id);

--
-- Name: sag_office_sugg_office_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sag_office_sugg_office_idx ON public.sag_office_suggestions USING btree (office_id);

--
-- Name: sag_office_sugg_sag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sag_office_sugg_sag_idx ON public.sag_office_suggestions USING btree (sag_id);

--
-- Name: scout_findings_apollo_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scout_findings_apollo_id_idx ON public.scout_findings USING btree (apollo_id) WHERE (apollo_id IS NOT NULL);

--
-- Name: scout_findings_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scout_findings_kind_idx ON public.scout_findings USING btree (kind);

--
-- Name: scout_findings_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scout_findings_search_idx ON public.scout_findings USING btree (search_id, created_at);

--
-- Name: scout_findings_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scout_findings_status_idx ON public.scout_findings USING btree (status);

--
-- Name: scout_jobs_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scout_jobs_search_idx ON public.scout_jobs USING btree (search_id);

--
-- Name: scout_jobs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scout_jobs_status_idx ON public.scout_jobs USING btree (status);

--
-- Name: scout_jobs_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scout_jobs_updated_idx ON public.scout_jobs USING btree (updated_at DESC);

--
-- Name: scout_messages_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scout_messages_search_idx ON public.scout_messages USING btree (search_id, created_at);

--
-- Name: scout_searches_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scout_searches_updated_idx ON public.scout_searches USING btree (updated_at DESC);

--
-- Name: scout_tool_calls_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scout_tool_calls_search_idx ON public.scout_tool_calls USING btree (search_id, created_at);

--
-- Name: scout_url_cache_fetched_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scout_url_cache_fetched_idx ON public.scout_url_cache USING btree (fetched_at);

--
-- Name: solicitations_is_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX solicitations_is_priority_idx ON public.solicitations USING btree (is_priority) WHERE (is_priority = true);

--
-- Name: solicitations_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX solicitations_owner_idx ON public.solicitations USING btree (owner) WHERE (owner <> ''::text);

--
-- Name: scout_jobs scout_jobs_touch_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER scout_jobs_touch_trg BEFORE UPDATE ON public.scout_jobs FOR EACH ROW EXECUTE FUNCTION public.scout_jobs_touch();

--
-- Name: apollo_phone_webhook_log apollo_phone_webhook_log_finding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apollo_phone_webhook_log
    ADD CONSTRAINT apollo_phone_webhook_log_finding_id_fkey FOREIGN KEY (finding_id) REFERENCES public.scout_findings(id) ON DELETE SET NULL;

--
-- Name: auth_allowlist auth_allowlist_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_allowlist
    ADD CONSTRAINT auth_allowlist_added_by_fkey FOREIGN KEY (added_by) REFERENCES auth.users(id) ON DELETE SET NULL;

--
-- Name: budget_om_sags budget_om_sags_appropriation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_om_sags
    ADD CONSTRAINT budget_om_sags_appropriation_id_fkey FOREIGN KEY (appropriation_id) REFERENCES public.budget_appropriations(id);

--
-- Name: budget_om_sags budget_om_sags_owning_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_om_sags
    ADD CONSTRAINT budget_om_sags_owning_org_id_fkey FOREIGN KEY (owning_org_id) REFERENCES public.budget_orgs(id);

--
-- Name: budget_orgs budget_orgs_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_orgs
    ADD CONSTRAINT budget_orgs_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.budget_orgs(id) ON DELETE SET NULL;

--
-- Name: budget_pes budget_pes_appropriation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_pes
    ADD CONSTRAINT budget_pes_appropriation_id_fkey FOREIGN KEY (appropriation_id) REFERENCES public.budget_appropriations(id);

--
-- Name: budget_pes budget_pes_owning_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_pes
    ADD CONSTRAINT budget_pes_owning_org_id_fkey FOREIGN KEY (owning_org_id) REFERENCES public.budget_orgs(id);

--
-- Name: budget_projects budget_projects_pe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_projects
    ADD CONSTRAINT budget_projects_pe_id_fkey FOREIGN KEY (pe_id) REFERENCES public.budget_pes(id) ON DELETE CASCADE;

--
-- Name: budget_topline_lines budget_topline_lines_appropriation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_topline_lines
    ADD CONSTRAINT budget_topline_lines_appropriation_id_fkey FOREIGN KEY (appropriation_id) REFERENCES public.budget_appropriations(id);

--
-- Name: contacts contacts_legislator_bioguide_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_legislator_bioguide_id_fkey FOREIGN KEY (legislator_bioguide_id) REFERENCES public.hill_members(bioguide_id) ON DELETE SET NULL;

--
-- Name: hill_committee_memberships hill_committee_memberships_bioguide_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hill_committee_memberships
    ADD CONSTRAINT hill_committee_memberships_bioguide_id_fkey FOREIGN KEY (bioguide_id) REFERENCES public.hill_members(bioguide_id) ON DELETE CASCADE;

--
-- Name: hill_committee_memberships hill_committee_memberships_thomas_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hill_committee_memberships
    ADD CONSTRAINT hill_committee_memberships_thomas_id_fkey FOREIGN KEY (thomas_id) REFERENCES public.hill_committees(thomas_id) ON DELETE CASCADE;

--
-- Name: offices offices_budget_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offices
    ADD CONSTRAINT offices_budget_org_id_fkey FOREIGN KEY (budget_org_id) REFERENCES public.budget_orgs(id) ON DELETE SET NULL;

--
-- Name: om_sag_narratives om_sag_narratives_sag_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.om_sag_narratives
    ADD CONSTRAINT om_sag_narratives_sag_fkey FOREIGN KEY (sag_id) REFERENCES public.budget_om_sags(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: pe_office_link_dismissals pe_office_link_dismissals_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_link_dismissals
    ADD CONSTRAINT pe_office_link_dismissals_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.offices(id) ON DELETE CASCADE;

--
-- Name: pe_office_link_dismissals pe_office_link_dismissals_pe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_link_dismissals
    ADD CONSTRAINT pe_office_link_dismissals_pe_id_fkey FOREIGN KEY (pe_id) REFERENCES public.budget_pes(id) ON DELETE CASCADE;

--
-- Name: pe_office_links pe_office_links_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_links
    ADD CONSTRAINT pe_office_links_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.offices(id) ON DELETE CASCADE;

--
-- Name: pe_office_links pe_office_links_pe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_links
    ADD CONSTRAINT pe_office_links_pe_id_fkey FOREIGN KEY (pe_id) REFERENCES public.budget_pes(id) ON DELETE CASCADE;

--
-- Name: pe_office_suggestions pe_office_suggestions_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_suggestions
    ADD CONSTRAINT pe_office_suggestions_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.offices(id) ON DELETE CASCADE;

--
-- Name: pe_office_suggestions pe_office_suggestions_pe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pe_office_suggestions
    ADD CONSTRAINT pe_office_suggestions_pe_id_fkey FOREIGN KEY (pe_id) REFERENCES public.budget_pes(id) ON DELETE CASCADE;

--
-- Name: proc_line_narratives proc_line_narratives_pe_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proc_line_narratives
    ADD CONSTRAINT proc_line_narratives_pe_fkey FOREIGN KEY (proc_line_id) REFERENCES public.budget_pes(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: sag_office_link_dismissals sag_office_link_dismissals_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sag_office_link_dismissals
    ADD CONSTRAINT sag_office_link_dismissals_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.offices(id) ON DELETE CASCADE;

--
-- Name: sag_office_link_dismissals sag_office_link_dismissals_sag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sag_office_link_dismissals
    ADD CONSTRAINT sag_office_link_dismissals_sag_id_fkey FOREIGN KEY (sag_id) REFERENCES public.budget_om_sags(id) ON DELETE CASCADE;

--
-- Name: sag_office_links sag_office_links_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sag_office_links
    ADD CONSTRAINT sag_office_links_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.offices(id) ON DELETE CASCADE;

--
-- Name: sag_office_links sag_office_links_sag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sag_office_links
    ADD CONSTRAINT sag_office_links_sag_id_fkey FOREIGN KEY (sag_id) REFERENCES public.budget_om_sags(id) ON DELETE CASCADE;

--
-- Name: sag_office_suggestions sag_office_suggestions_office_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sag_office_suggestions
    ADD CONSTRAINT sag_office_suggestions_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.offices(id) ON DELETE CASCADE;

--
-- Name: sag_office_suggestions sag_office_suggestions_sag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sag_office_suggestions
    ADD CONSTRAINT sag_office_suggestions_sag_id_fkey FOREIGN KEY (sag_id) REFERENCES public.budget_om_sags(id) ON DELETE CASCADE;

--
-- Name: scout_findings scout_findings_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_findings
    ADD CONSTRAINT scout_findings_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.scout_searches(id) ON DELETE CASCADE;

--
-- Name: scout_findings scout_findings_sug_legislator_bioguide_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_findings
    ADD CONSTRAINT scout_findings_sug_legislator_bioguide_id_fkey FOREIGN KEY (suggested_legislator_bioguide_id) REFERENCES public.hill_members(bioguide_id) ON DELETE SET NULL;

--
-- Name: scout_jobs scout_jobs_legislator_bioguide_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_jobs
    ADD CONSTRAINT scout_jobs_legislator_bioguide_id_fkey FOREIGN KEY (legislator_bioguide_id) REFERENCES public.hill_members(bioguide_id) ON DELETE SET NULL;

--
-- Name: scout_jobs scout_jobs_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_jobs
    ADD CONSTRAINT scout_jobs_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.scout_searches(id) ON DELETE CASCADE;

--
-- Name: scout_messages scout_messages_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_messages
    ADD CONSTRAINT scout_messages_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.scout_searches(id) ON DELETE CASCADE;

--
-- Name: scout_tool_calls scout_tool_calls_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_tool_calls
    ADD CONSTRAINT scout_tool_calls_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.scout_messages(id) ON DELETE SET NULL;

--
-- Name: scout_tool_calls scout_tool_calls_search_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scout_tool_calls
    ADD CONSTRAINT scout_tool_calls_search_id_fkey FOREIGN KEY (search_id) REFERENCES public.scout_searches(id) ON DELETE CASCADE;

--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

--
-- Name: auth_allowlist admin_read_allowlist; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_read_allowlist ON public.auth_allowlist FOR SELECT TO authenticated USING (public.is_admin());

--
-- Name: user_roles admin_reads_all_roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_reads_all_roles ON public.user_roles FOR SELECT TO authenticated USING (public.is_admin());

--
-- Name: budget_appropriations admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.budget_appropriations TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: budget_om_sags admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.budget_om_sags TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: budget_orgs admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.budget_orgs TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: budget_pes admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.budget_pes TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: budget_projects admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.budget_projects TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: budget_topline_lines admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.budget_topline_lines TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: hill_committee_memberships admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.hill_committee_memberships TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: hill_committees admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.hill_committees TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: hill_members admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.hill_members TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: om_activity_years admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.om_activity_years TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: om_sag_narratives admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.om_sag_narratives TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: pe_budget_years admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.pe_budget_years TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: pe_narratives admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.pe_narratives TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: pe_title_overrides admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.pe_title_overrides TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: proc_line_narratives admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.proc_line_narratives TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: procurement_line_years admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write ON public.procurement_line_years TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: auth_allowlist admin_write_allowlist; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_write_allowlist ON public.auth_allowlist TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: user_roles admin_writes_roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_writes_roles ON public.user_roles TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

--
-- Name: apollo_phone_webhook_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.apollo_phone_webhook_log ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_allowlist; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_allowlist ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_appropriations authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.budget_appropriations FOR SELECT TO authenticated USING (true);

--
-- Name: budget_om_sags authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.budget_om_sags FOR SELECT TO authenticated USING (true);

--
-- Name: budget_orgs authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.budget_orgs FOR SELECT TO authenticated USING (true);

--
-- Name: budget_pes authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.budget_pes FOR SELECT TO authenticated USING (true);

--
-- Name: budget_projects authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.budget_projects FOR SELECT TO authenticated USING (true);

--
-- Name: budget_topline_lines authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.budget_topline_lines FOR SELECT TO authenticated USING (true);

--
-- Name: contacts authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.contacts FOR SELECT TO authenticated USING (true);

--
-- Name: hill_committee_memberships authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.hill_committee_memberships FOR SELECT TO authenticated USING (true);

--
-- Name: hill_committees authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.hill_committees FOR SELECT TO authenticated USING (true);

--
-- Name: hill_meetings authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.hill_meetings FOR SELECT TO authenticated USING (true);

--
-- Name: hill_members authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.hill_members FOR SELECT TO authenticated USING (true);

--
-- Name: hill_requests authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.hill_requests FOR SELECT TO authenticated USING (true);

--
-- Name: letters authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.letters FOR SELECT TO authenticated USING (true);

--
-- Name: office_media authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.office_media FOR SELECT TO authenticated USING (true);

--
-- Name: offices authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.offices FOR SELECT TO authenticated USING (true);

--
-- Name: om_activity_years authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.om_activity_years FOR SELECT TO authenticated USING (true);

--
-- Name: om_sag_narratives authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.om_sag_narratives FOR SELECT TO authenticated USING (true);

--
-- Name: pe_budget_years authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.pe_budget_years FOR SELECT TO authenticated USING (true);

--
-- Name: pe_narratives authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.pe_narratives FOR SELECT TO authenticated USING (true);

--
-- Name: pe_office_link_dismissals authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.pe_office_link_dismissals FOR SELECT TO authenticated USING (true);

--
-- Name: pe_office_links authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.pe_office_links FOR SELECT TO authenticated USING (true);

--
-- Name: pe_office_suggestions authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.pe_office_suggestions FOR SELECT TO authenticated USING (true);

--
-- Name: pe_title_overrides authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.pe_title_overrides FOR SELECT TO authenticated USING (true);

--
-- Name: proc_line_narratives authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.proc_line_narratives FOR SELECT TO authenticated USING (true);

--
-- Name: procurement_line_years authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.procurement_line_years FOR SELECT TO authenticated USING (true);

--
-- Name: requests authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.requests FOR SELECT TO authenticated USING (true);

--
-- Name: sag_office_link_dismissals authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.sag_office_link_dismissals FOR SELECT TO authenticated USING (true);

--
-- Name: sag_office_links authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.sag_office_links FOR SELECT TO authenticated USING (true);

--
-- Name: sag_office_suggestions authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.sag_office_suggestions FOR SELECT TO authenticated USING (true);

--
-- Name: solicitations authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.solicitations FOR SELECT TO authenticated USING (true);

--
-- Name: washops authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY authenticated_read ON public.washops FOR SELECT TO authenticated USING (true);

--
-- Name: budget_appropriations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_appropriations ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_om_sags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_om_sags ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_orgs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_orgs ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_pes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_pes ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_projects ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_topline_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_topline_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: contacts editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.contacts FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: hill_meetings editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.hill_meetings FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: hill_requests editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.hill_requests FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: letters editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.letters FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: office_media editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.office_media FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: offices editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.offices FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: pe_office_link_dismissals editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.pe_office_link_dismissals FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: pe_office_links editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.pe_office_links FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: pe_office_suggestions editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.pe_office_suggestions FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: requests editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.requests FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: sag_office_link_dismissals editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.sag_office_link_dismissals FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: sag_office_links editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.sag_office_links FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: sag_office_suggestions editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.sag_office_suggestions FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: solicitations editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.solicitations FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: washops editor_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_delete ON public.washops FOR DELETE TO authenticated USING (public.is_editor());

--
-- Name: apollo_phone_webhook_log editor_full; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_full ON public.apollo_phone_webhook_log TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: scout_findings editor_full; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_full ON public.scout_findings TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: scout_jobs editor_full; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_full ON public.scout_jobs TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: scout_messages editor_full; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_full ON public.scout_messages TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: scout_searches editor_full; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_full ON public.scout_searches TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: scout_tool_calls editor_full; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_full ON public.scout_tool_calls TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: scout_url_cache editor_full; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_full ON public.scout_url_cache TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: contacts editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.contacts FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: hill_meetings editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.hill_meetings FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: hill_requests editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.hill_requests FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: letters editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.letters FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: office_media editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.office_media FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: offices editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.offices FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: pe_office_link_dismissals editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.pe_office_link_dismissals FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: pe_office_links editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.pe_office_links FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: pe_office_suggestions editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.pe_office_suggestions FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: requests editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.requests FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: sag_office_link_dismissals editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.sag_office_link_dismissals FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: sag_office_links editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.sag_office_links FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: sag_office_suggestions editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.sag_office_suggestions FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: solicitations editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.solicitations FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: washops editor_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_insert ON public.washops FOR INSERT TO authenticated WITH CHECK (public.is_editor());

--
-- Name: contacts editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.contacts FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: hill_meetings editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.hill_meetings FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: hill_requests editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.hill_requests FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: letters editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.letters FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: office_media editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.office_media FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: offices editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.offices FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: pe_office_link_dismissals editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.pe_office_link_dismissals FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: pe_office_links editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.pe_office_links FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: pe_office_suggestions editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.pe_office_suggestions FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: requests editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.requests FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: sag_office_link_dismissals editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.sag_office_link_dismissals FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: sag_office_links editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.sag_office_links FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: sag_office_suggestions editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.sag_office_suggestions FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: solicitations editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.solicitations FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: washops editor_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY editor_update ON public.washops FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor());

--
-- Name: hill_committee_memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hill_committee_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: hill_committees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hill_committees ENABLE ROW LEVEL SECURITY;

--
-- Name: hill_meetings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hill_meetings ENABLE ROW LEVEL SECURITY;

--
-- Name: hill_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hill_members ENABLE ROW LEVEL SECURITY;

--
-- Name: hill_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hill_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: letters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.letters ENABLE ROW LEVEL SECURITY;

--
-- Name: office_media; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.office_media ENABLE ROW LEVEL SECURITY;

--
-- Name: offices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.offices ENABLE ROW LEVEL SECURITY;

--
-- Name: om_activity_years; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.om_activity_years ENABLE ROW LEVEL SECURITY;

--
-- Name: om_sag_narratives; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.om_sag_narratives ENABLE ROW LEVEL SECURITY;

--
-- Name: pe_budget_years; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pe_budget_years ENABLE ROW LEVEL SECURITY;

--
-- Name: pe_narratives; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pe_narratives ENABLE ROW LEVEL SECURITY;

--
-- Name: pe_office_link_dismissals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pe_office_link_dismissals ENABLE ROW LEVEL SECURITY;

--
-- Name: pe_office_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pe_office_links ENABLE ROW LEVEL SECURITY;

--
-- Name: pe_office_suggestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pe_office_suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: pe_title_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pe_title_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: proc_line_narratives; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.proc_line_narratives ENABLE ROW LEVEL SECURITY;

--
-- Name: procurement_line_years; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.procurement_line_years ENABLE ROW LEVEL SECURITY;

--
-- Name: requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.requests ENABLE ROW LEVEL SECURITY;

--
-- Name: sag_office_link_dismissals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sag_office_link_dismissals ENABLE ROW LEVEL SECURITY;

--
-- Name: sag_office_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sag_office_links ENABLE ROW LEVEL SECURITY;

--
-- Name: sag_office_suggestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sag_office_suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: scout_findings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scout_findings ENABLE ROW LEVEL SECURITY;

--
-- Name: scout_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scout_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: scout_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scout_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: scout_searches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scout_searches ENABLE ROW LEVEL SECURITY;

--
-- Name: scout_tool_calls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scout_tool_calls ENABLE ROW LEVEL SECURITY;

--
-- Name: scout_url_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scout_url_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: solicitations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.solicitations ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles user_reads_own_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_reads_own_role ON public.user_roles FOR SELECT TO authenticated USING ((user_id = auth.uid()));

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: washops; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.washops ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

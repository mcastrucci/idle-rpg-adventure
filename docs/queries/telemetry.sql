-- Read-only, PostgreSQL 14+ telemetry extracts. Run with psql -X -v ON_ERROR_STOP=1 -f docs/queries/telemetry.sql.
-- Bind no client identity: group by internal actor/account IDs only in this trusted report.
-- Sessions are socket-connected observations; crash intervals stop at last_seen_at, never at query time.

-- Q1: authenticated connection intervals and per-account session/observed-connected totals.
WITH intervals AS (
  SELECT account_id, connection_id, started_at,
         COALESCE(ended_at, last_seen_at) AS observed_end,
         ended_at IS NULL AS ended_by_last_observation
  FROM rpg_connection_sessions
), durations AS (
  SELECT *, GREATEST(0, EXTRACT(EPOCH FROM (observed_end - started_at))) AS observed_seconds
  FROM intervals
)
SELECT account_id, count(*) AS connection_intervals,
       sum(observed_seconds) AS observed_connected_seconds,
       avg(observed_seconds) AS mean_interval_seconds,
       count(*) FILTER (WHERE ended_by_last_observation) AS open_or_crashed_intervals
FROM durations GROUP BY account_id ORDER BY account_id;

-- Q2: discoveries and persisted completed-area time by actor and area (rpg_completed_areas.completed_at).
SELECT d.actor_id, d.area_id, count(DISTINCT d.location_id) AS distinct_locations_discovered,
       min(d.discovered_at) AS first_discovery_at, max(d.discovered_at) AS last_discovery_at,
       c.completed_at AS conquered_at,
       EXTRACT(EPOCH FROM (c.completed_at - min(d.discovered_at))) AS seconds_from_first_recorded_discovery_to_conquest
FROM rpg_area_discoveries d
LEFT JOIN rpg_completed_areas c USING (actor_id, area_id)
GROUP BY d.actor_id, d.area_id, c.completed_at ORDER BY d.actor_id, d.area_id;

-- Q3: per-expedition rows used by Q7-Q8, with strict report-shape/coverage checks.
WITH base AS (
  SELECT e.*, e.terminal_report AS r,
    CASE WHEN jsonb_typeof(e.terminal_report)='object'
       AND e.terminal_report->'version'='1'::jsonb AND e.terminal_report->>'kind'='settled'
       AND jsonb_typeof(e.terminal_report->'endsAtMs')='number'
       AND (e.terminal_report->>'endsAtMs') ~ '^[0-9]+$'
       AND jsonb_typeof(e.terminal_report->'xp')='array'
    THEN true ELSE false END AS report_shape_supported
  FROM rpg_expeditions e
), report_valid AS (
  SELECT *, CASE WHEN report_shape_supported THEN
    CASE WHEN (r->>'endsAtMs')::numeric BETWEEN starts_at_ms AND planned_ends_at_ms THEN true ELSE false END
    ELSE false END AS report_supported
  FROM base
), actor_xp AS (
  SELECT b.id, count(x.item) FILTER (WHERE jsonb_typeof(x.item)='object'
           AND x.item->>'actorId'=b.actor_id::text) AS actor_xp_rows,
         (array_agg(x.item) FILTER (WHERE jsonb_typeof(x.item)='object'
           AND x.item->>'actorId'=b.actor_id::text))[1] AS xp_row
  FROM report_valid b LEFT JOIN LATERAL jsonb_array_elements(
    CASE WHEN b.report_supported THEN b.r->'xp' ELSE '[]'::jsonb END
  ) x(item) ON true GROUP BY b.id
), parsed AS (
  SELECT b.*, a.actor_xp_rows, a.xp_row,
    CASE WHEN b.report_supported AND a.actor_xp_rows=1 AND jsonb_typeof(a.xp_row->'xpEarned')='number'
      AND (a.xp_row->>'xpEarned') ~ '^[0-9]+$'
      THEN CASE WHEN (a.xp_row->>'xpEarned')::numeric <= 9007199254740991
        THEN (a.xp_row->>'xpEarned')::numeric END END AS xp_earned,
    CASE WHEN b.report_supported AND a.actor_xp_rows=1 AND jsonb_typeof(a.xp_row->'xpPenaltyLost')='number'
      AND (a.xp_row->>'xpPenaltyLost') ~ '^[0-9]+$'
      THEN CASE WHEN (a.xp_row->>'xpPenaltyLost')::numeric <= 9007199254740991
        THEN (a.xp_row->>'xpPenaltyLost')::numeric END END AS xp_penalty,
    CASE WHEN b.report_supported THEN (b.r->>'endsAtMs')::numeric END AS report_end_ms
  FROM report_valid b JOIN actor_xp a USING(id)
), metrics AS (
  SELECT *, CASE WHEN report_end_ms IS NOT NULL THEN report_end_ms-starts_at_ms END AS effective_ms,
    CASE WHEN report_end_ms IS NOT NULL AND xp_earned IS NOT NULL AND xp_penalty IS NOT NULL
      THEN xp_earned-xp_penalty END AS xp_net
  FROM parsed
)
SELECT id AS expedition_id, actor_id, area_id, activity_id, status, outcome,
       to_timestamp(starts_at_ms / 1000.0) AS started_at,
       effective_ms AS effective_duration_ms, xp_earned, xp_penalty AS xp_penalty_lost,
       xp_net, CASE WHEN effective_ms > 0 AND xp_earned IS NOT NULL THEN xp_earned*3600000/effective_ms END AS gross_xp_per_hour,
       CASE WHEN effective_ms > 0 AND xp_net IS NOT NULL THEN xp_net*3600000/effective_ms END AS net_xp_per_hour,
       COALESCE(report_supported AND actor_xp_rows=1 AND effective_ms > 0 AND xp_net IS NOT NULL,false) AS rate_covered,
       CASE WHEN NOT report_supported THEN 'unsupported_or_recovery_report'
            WHEN actor_xp_rows<>1 THEN 'missing_or_duplicate_actor_xp'
            WHEN effective_ms IS NULL OR effective_ms <= 0 THEN 'unknown_or_zero_duration'
            WHEN xp_net IS NULL THEN 'invalid_actor_xp' ELSE 'covered' END AS coverage_status
FROM metrics ORDER BY starts_at_ms, id;

-- Q4: live XP/hour per actor and area over CLOSED observed entry-to-close wall time.
-- Per-actor-instance XP is preaggregated; duplicate XP rows cannot multiply elapsed time. There is no backfill; rows follow live-instance retention.
WITH closed_entries AS (
  SELECT e.instance_id, e.actor_id, e.area_id, e.started_at, i.closed_at,
         EXTRACT(EPOCH FROM (i.closed_at-e.started_at)) AS elapsed_seconds
  FROM rpg_live_entries e JOIN live_instances i USING (instance_id)
  WHERE i.game_id='rpg' AND i.status='closed' AND i.closed_at IS NOT NULL
), xp AS (
  SELECT instance_id, actor_id, sum(granted_xp)::numeric AS gross_xp
  FROM rpg_live_xp_events GROUP BY instance_id, actor_id
), deaths AS (
  SELECT instance_id, actor_id, sum(xp_lost)::numeric AS xp_penalty_lost
  FROM rpg_live_deaths GROUP BY instance_id, actor_id
), per_instance AS (
  -- Presence of rpg_live_entries is the post-0007 instrumentation marker. A missing XP
  -- event for a recorded entry is a known zero; pre-0007 runs have no entry row at all.
  SELECT e.*, COALESCE(x.gross_xp,0) AS gross_xp, d.xp_penalty_lost
  FROM closed_entries e LEFT JOIN xp x USING (instance_id, actor_id)
  LEFT JOIN deaths d USING (instance_id, actor_id)
)
SELECT actor_id, area_id, count(*) AS closed_observed_entries,
       count(*) FILTER (WHERE elapsed_seconds>0) AS positive_duration_entries,
       count(*) FILTER (WHERE elapsed_seconds<=0) AS excluded_nonpositive_duration_entries,
       sum(elapsed_seconds) FILTER (WHERE elapsed_seconds>0) AS covered_elapsed_seconds,
       sum(gross_xp) FILTER (WHERE elapsed_seconds>0) AS gross_xp,
       sum(COALESCE(xp_penalty_lost,0)) FILTER (WHERE elapsed_seconds>0) AS known_death_xp_penalty_lost,
       sum(gross_xp-COALESCE(xp_penalty_lost,0)) FILTER (WHERE elapsed_seconds>0) AS net_xp,
       CASE WHEN sum(elapsed_seconds) FILTER (WHERE elapsed_seconds>0)>0
         THEN sum(gross_xp) FILTER (WHERE elapsed_seconds>0)*3600 / sum(elapsed_seconds) FILTER (WHERE elapsed_seconds>0) END AS gross_xp_per_hour,
       CASE WHEN sum(elapsed_seconds) FILTER (WHERE elapsed_seconds>0)>0
         THEN sum(gross_xp-COALESCE(xp_penalty_lost,0)) FILTER (WHERE elapsed_seconds>0)*3600 / sum(elapsed_seconds) FILTER (WHERE elapsed_seconds>0) END AS net_xp_per_hour
FROM per_instance GROUP BY actor_id, area_id ORDER BY actor_id, area_id;

-- Q5: conquest outbox event followed by later return. Emits both same-area and any-area interpretations.
WITH conquest AS (SELECT actor_id, area_id, occurred_at FROM rpg_region_conquered_events),
returns AS (
 SELECT c.actor_id, c.area_id AS conquered_area, c.occurred_at AS conquered_at,
   min(e.started_at) FILTER (WHERE e.area_id=c.area_id AND e.started_at>c.occurred_at) AS same_area_return_at,
   min(e.started_at) FILTER (WHERE e.started_at>c.occurred_at) AS any_area_return_at
 FROM conquest c LEFT JOIN rpg_live_entries e ON e.actor_id=c.actor_id
 GROUP BY c.actor_id,c.area_id,c.occurred_at
)
SELECT *, EXTRACT(EPOCH FROM (same_area_return_at-conquered_at)) AS seconds_to_same_area_return,
       EXTRACT(EPOCH FROM (any_area_return_at-conquered_at)) AS seconds_to_any_area_return
FROM returns ORDER BY actor_id, conquered_at;

-- Q6: Region 2 repeat-attempt support is unavailable in this build. Do not infer attempts from invalid requests.
SELECT 'unavailable_unsupported'::text AS availability,
       'No Region 2 live content or attempt event is persisted; criterion requires a real playtest.'::text AS reason;

-- Q7: lifecycle counts and report-recorded deaths; death coverage is explicit and independent of XP penalty flags.
WITH reports AS (
 SELECT e.id,e.actor_id,e.area_id,e.status,e.settled_reason,e.terminal_report r,
   CASE WHEN jsonb_typeof(e.terminal_report)='object' AND e.terminal_report->'version'='1'::jsonb
      AND e.terminal_report->>'kind'='settled' AND jsonb_typeof(e.terminal_report->'segments')='array'
     THEN true ELSE false END death_report_supported,
   EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.terminal_report)='object'
       AND e.terminal_report->'version'='1'::jsonb AND e.terminal_report->>'kind'='settled'
       AND jsonb_typeof(e.terminal_report->'xp')='array' THEN e.terminal_report->'xp' ELSE '[]'::jsonb END) x(item)
     WHERE jsonb_typeof(x.item)='object' AND x.item->>'actorId'=e.actor_id::text
       AND x.item->'xpPenaltyApplied'='true'::jsonb) AS actor_xp_penalty_applied
 FROM rpg_expeditions e
), report_deaths AS (
 SELECT r.id,r.actor_id,r.area_id
 FROM reports r
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN r.death_report_supported THEN r.r->'segments' ELSE '[]'::jsonb END) s(item)
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.item->'events')='array' THEN s.item->'events' ELSE '[]'::jsonb END) ev(item)
 WHERE jsonb_typeof(ev.item)='object' AND ev.item->>'type'='death' AND ev.item->>'actorId'=r.actor_id::text
 GROUP BY r.id,r.actor_id,r.area_id
)
SELECT r.actor_id,r.area_id,count(*) starts,
  count(*) FILTER (WHERE r.status='running') running,
  count(*) FILTER (WHERE r.status='completed') completed,
  count(*) FILTER (WHERE r.status='cancelled') cancelled,
  count(*) FILTER (WHERE r.settled_reason='cancelled') user_cancelled,
  count(*) FILTER (WHERE r.status<>'running') terminal_expeditions,
  count(*) FILTER (WHERE r.status<>'running' AND r.death_report_supported) death_report_covered_expeditions,
  count(DISTINCT d.id) AS expeditions_with_recorded_actor_death,
  count(*) FILTER (WHERE r.status<>'running' AND NOT r.death_report_supported) death_report_unknown_expeditions,
  count(*) FILTER (WHERE r.actor_xp_penalty_applied) reports_with_actor_xp_penalty_applied,
  count(*) FILTER (WHERE r.status<>'running' AND NOT COALESCE(jsonb_typeof(r.r)='object' AND r.r->'version'='1'::jsonb AND r.r->>'kind'='settled',false)) unsupported_or_recovery_reports
FROM reports r LEFT JOIN report_deaths d ON d.id=r.id
GROUP BY r.actor_id,r.area_id ORDER BY r.actor_id,r.area_id;

-- Q8: per-player idle gross/lost/net XP per hour and coverage/exclusion counts.
WITH source AS (
 SELECT e.id,e.actor_id,e.area_id,e.activity_id,e.status,e.starts_at_ms,e.planned_ends_at_ms,e.terminal_report r
 FROM rpg_expeditions e
), report_shape AS (
 SELECT *,CASE WHEN jsonb_typeof(r)='object' AND r->'version'='1'::jsonb AND r->>'kind'='settled'
   AND jsonb_typeof(r->'endsAtMs')='number' AND (r->>'endsAtMs') ~ '^[0-9]+$'
   AND jsonb_typeof(r->'xp')='array' THEN true ELSE false END shape_ok
 FROM source WHERE status<>'running'
), report AS (
 SELECT *,CASE WHEN shape_ok THEN
   CASE WHEN (r->>'endsAtMs')::numeric BETWEEN starts_at_ms AND planned_ends_at_ms THEN true ELSE false END
   ELSE false END supported
 FROM report_shape
), actor_rows AS (
 SELECT b.*,count(x.item) FILTER (WHERE jsonb_typeof(x.item)='object' AND x.item->>'actorId'=b.actor_id::text) n,
   (array_agg(x.item) FILTER (WHERE jsonb_typeof(x.item)='object' AND x.item->>'actorId'=b.actor_id::text))[1] xp
 FROM report b LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN b.supported THEN b.r->'xp' ELSE '[]'::jsonb END)x(item) ON true
 GROUP BY b.id,b.actor_id,b.area_id,b.activity_id,b.status,b.starts_at_ms,b.planned_ends_at_ms,b.r,b.shape_ok,b.supported
), parsed AS (
 SELECT *,
   CASE WHEN supported AND n=1 AND jsonb_typeof(xp->'xpEarned')='number' AND (xp->>'xpEarned') ~ '^[0-9]+$'
     THEN CASE WHEN (xp->>'xpEarned')::numeric<=9007199254740991 THEN (xp->>'xpEarned')::numeric END END gross,
   CASE WHEN supported AND n=1 AND jsonb_typeof(xp->'xpPenaltyLost')='number' AND (xp->>'xpPenaltyLost') ~ '^[0-9]+$'
     THEN CASE WHEN (xp->>'xpPenaltyLost')::numeric<=9007199254740991 THEN (xp->>'xpPenaltyLost')::numeric END END penalty,
   CASE WHEN supported THEN (r->>'endsAtMs')::numeric-starts_at_ms END duration_ms
 FROM actor_rows
), rates AS (
 SELECT *,CASE WHEN gross IS NOT NULL AND penalty IS NOT NULL THEN gross-penalty END net FROM parsed
)
SELECT actor_id,area_id,activity_id,count(*) terminal_expeditions,
 count(*) FILTER (WHERE duration_ms>0 AND gross IS NOT NULL AND penalty IS NOT NULL AND net IS NOT NULL) covered_expeditions,
 count(*) FILTER (WHERE duration_ms IS NULL OR duration_ms<=0 OR gross IS NULL OR penalty IS NULL OR net IS NULL) excluded_or_uncovered_expeditions,
 sum(duration_ms) FILTER (WHERE duration_ms>0 AND gross IS NOT NULL AND penalty IS NOT NULL AND net IS NOT NULL) effective_duration_ms,
 sum(gross) FILTER (WHERE duration_ms>0 AND gross IS NOT NULL AND penalty IS NOT NULL AND net IS NOT NULL) gross_xp,
 sum(penalty) FILTER (WHERE duration_ms>0 AND gross IS NOT NULL AND penalty IS NOT NULL AND net IS NOT NULL) xp_penalty_lost,
 sum(net) FILTER (WHERE duration_ms>0 AND gross IS NOT NULL AND penalty IS NOT NULL AND net IS NOT NULL) net_xp,
 CASE WHEN sum(duration_ms) FILTER (WHERE duration_ms>0 AND gross IS NOT NULL AND penalty IS NOT NULL AND net IS NOT NULL)>0 THEN
  sum(gross) FILTER (WHERE duration_ms>0 AND gross IS NOT NULL AND penalty IS NOT NULL AND net IS NOT NULL)*3600000/sum(duration_ms) FILTER (WHERE duration_ms>0 AND gross IS NOT NULL AND penalty IS NOT NULL AND net IS NOT NULL) END gross_xp_per_hour,
 CASE WHEN sum(duration_ms) FILTER (WHERE duration_ms>0 AND gross IS NOT NULL AND penalty IS NOT NULL AND net IS NOT NULL)>0 THEN
  sum(net) FILTER (WHERE duration_ms>0 AND gross IS NOT NULL AND penalty IS NOT NULL AND net IS NOT NULL)*3600000/sum(duration_ms) FILTER (WHERE duration_ms>0 AND gross IS NOT NULL AND penalty IS NOT NULL AND net IS NOT NULL) END net_xp_per_hour
FROM rates GROUP BY actor_id,area_id,activity_id ORDER BY actor_id,area_id,activity_id;

-- Q9: closed RPG instances with/without immutable entry attribution; unknown area is never guessed.
WITH participant_rows AS (SELECT i.instance_id,i.closed_at,p->>'actorId' actor_id
 FROM live_instances i CROSS JOIN LATERAL jsonb_array_elements(i.participants) p
 WHERE i.game_id='rpg' AND i.status='closed'), tagged AS (
 SELECT p.*,e.area_id,e.started_at,CASE WHEN e.instance_id IS NULL THEN false ELSE true END has_entry
 FROM participant_rows p LEFT JOIN rpg_live_entries e ON e.instance_id=p.instance_id AND e.actor_id::text=p.actor_id)
SELECT actor_id,count(*) closed_instance_participations,
 count(*) FILTER(WHERE has_entry) instrumented_attributed_participations,
 count(*) FILTER(WHERE NOT has_entry) legacy_or_unattributed_participations,
 count(*) FILTER(WHERE has_entry AND closed_at<=started_at) excluded_nonpositive_duration
FROM tagged GROUP BY actor_id ORDER BY actor_id;

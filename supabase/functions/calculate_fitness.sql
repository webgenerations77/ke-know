-- Helper: MD Keno prize lookup ($1 wager)
create or replace function keno_prize(p_spots integer, p_matches integer)
returns numeric as $$
begin
  return case p_spots
    when 1  then case when p_matches = 1 then 2 else 0 end
    when 2  then case when p_matches = 2 then 10 else 0 end
    when 3  then case p_matches when 2 then 2  when 3 then 25    else 0 end
    when 4  then case p_matches when 2 then 1  when 3 then 5   when 4 then 50    else 0 end
    when 5  then case p_matches when 3 then 2  when 4 then 15  when 5 then 300   else 0 end
    when 6  then case p_matches when 3 then 1  when 4 then 5   when 5 then 50    when 6 then 1000   else 0 end
    when 7  then case p_matches when 3 then 1  when 4 then 3   when 5 then 15    when 6 then 100    when 7 then 2500   else 0 end
    when 8  then case p_matches when 4 then 2  when 5 then 10  when 6 then 50    when 7 then 500    when 8 then 10000  else 0 end
    when 9  then case p_matches when 0 then 2  when 5 then 5   when 6 then 20    when 7 then 100    when 8 then 2500   when 9  then 25000  else 0 end
    when 10 then case p_matches when 0 then 4  when 5 then 2   when 6 then 10    when 7 then 50     when 8 then 400    when 9  then 4000   when 10 then 100000 else 0 end
    else 0
  end;
end;
$$ language plpgsql immutable;

-- Main fitness function: simulate strategy on training and test windows, store results
-- Called from Strategy Lab UI for individual strategy evaluation.
-- The TypeScript evolution loop uses the faster in-memory TS implementation instead.
create or replace function calculate_fitness(
  p_strategy_id integer,
  p_training_end_game_num integer,
  p_test_start_game_num integer
) returns jsonb as $$
declare
  v_genome            jsonb;
  v_spot_count        integer;
  v_lookback          integer;
  v_weighting_method  text;
  v_decay_rate        numeric;
  v_boost_cutoff      integer;
  v_boost_mult        numeric;
  v_gap_weight        numeric;
  v_gap_threshold     integer;
  v_w_freq            numeric;
  v_w_rec             numeric;
  v_w_gap             numeric;
  v_w_str             numeric;
  v_sum_w             numeric;

  v_game              record;
  v_picks             integer[];
  v_matches           integer;
  v_prize             numeric;
  v_pnl               numeric;

  -- training accumulators
  v_tr_pnl            numeric := 0;
  v_tr_games          integer := 0;
  v_tr_wins           integer := 0;
  v_tr_matches        numeric := 0;
  v_tr_best           numeric := 0;
  v_tr_streak         integer := 0;
  v_tr_max_streak     integer := 0;

  -- test accumulators
  v_te_pnl            numeric := 0;
  v_te_games          integer := 0;
  v_te_wins           integer := 0;
  v_te_matches        numeric := 0;
  v_te_best           numeric := 0;
  v_te_streak         integer := 0;
  v_te_max_streak     integer := 0;

  v_live_count        integer;
  v_live_total_pnl    numeric;
  v_live_ppg          numeric;
  v_rw_bonus          numeric;
  v_consistency       numeric;
  v_fitness           numeric;
  v_test_ppg          numeric;
  v_win_rate          numeric;
  v_result_id         integer;
begin
  select genome, spot_count
  into v_genome, v_spot_count
  from strategies where id = p_strategy_id;

  if v_genome is null then return null; end if;

  -- Extract genome parameters with safe defaults
  v_lookback         := coalesce((v_genome->>'lookback_games')::integer, 500);
  v_weighting_method := coalesce(v_genome->>'weighting_method', 'linear_decay');
  v_decay_rate       := coalesce((v_genome->>'decay_rate')::numeric, 0.01);
  v_boost_cutoff     := coalesce((v_genome->>'recency_boost_cutoff')::integer, 5);
  v_boost_mult       := coalesce((v_genome->>'recency_boost_multiplier')::numeric, 2.0);
  v_gap_weight       := coalesce((v_genome->>'gap_weight')::numeric, 0.3);
  v_gap_threshold    := coalesce((v_genome->>'gap_threshold')::integer, 20);
  v_w_freq           := coalesce((v_genome->>'w_frequency')::numeric, 0.3);
  v_w_rec            := coalesce((v_genome->>'w_recency')::numeric, 0.4);
  v_w_gap            := coalesce((v_genome->>'w_gap')::numeric, 0.2);
  v_w_str            := coalesce((v_genome->>'w_streak')::numeric, 0.1);

  -- Normalize composite weights to sum to 1
  v_sum_w := v_w_freq + v_w_rec + v_w_gap + v_w_str;
  if v_sum_w > 0 then
    v_w_freq := v_w_freq / v_sum_w;
    v_w_rec  := v_w_rec  / v_sum_w;
    v_w_gap  := v_w_gap  / v_sum_w;
    v_w_str  := v_w_str  / v_sum_w;
  else
    v_w_freq := 0.4; v_w_rec := 0.4; v_w_gap := 0.1; v_w_str := 0.1;
  end if;

  -- ---- TRAINING SET ----
  for v_game in
    select game_num, hits from games
    where game_num <= p_training_end_game_num
    order by game_num asc
  loop
    -- Score all 80 numbers using the lookback window of prior games
    select array(
      select num
      from (
        select
          num,
          sum(
            (case v_weighting_method
              when 'raw'               then 1.0
              when 'linear_decay'      then greatest(0.0, 1.0 - rk::numeric / nullif(v_lookback, 0))
              else                          exp(-v_decay_rate * rk)
            end) *
            (case when rk < v_boost_cutoff then v_boost_mult else 1.0 end)
          ) as freq_score,
          min(rk) as min_rk
        from (
          select unnest(hits) as num,
                 (row_number() over (order by game_num desc)) - 1 as rk
          from games
          where game_num < v_game.game_num
          order by game_num desc
          limit v_lookback
        ) expanded
        group by num
      ) scored
      order by
        (freq_score + case when min_rk > v_gap_threshold then v_gap_weight else 0.0 end) desc
      limit v_spot_count
    ) into v_picks;

    -- Count matches against actual draw
    select count(*) into v_matches
    from unnest(v_picks) pk
    where pk = any(v_game.hits);

    v_prize := keno_prize(v_spot_count, v_matches);
    v_pnl   := v_prize - 1;

    v_tr_pnl     := v_tr_pnl + v_pnl;
    v_tr_games   := v_tr_games + 1;
    v_tr_matches := v_tr_matches + v_matches;
    if v_prize > 0 then
      v_tr_wins   := v_tr_wins + 1;
      v_tr_streak := 0;
      if v_prize > v_tr_best then v_tr_best := v_prize; end if;
    else
      v_tr_streak := v_tr_streak + 1;
      if v_tr_streak > v_tr_max_streak then v_tr_max_streak := v_tr_streak; end if;
    end if;
  end loop;

  -- ---- TEST SET ----
  for v_game in
    select game_num, hits from games
    where game_num >= p_test_start_game_num
    order by game_num asc
  loop
    select array(
      select num
      from (
        select
          num,
          sum(
            (case v_weighting_method
              when 'raw'               then 1.0
              when 'linear_decay'      then greatest(0.0, 1.0 - rk::numeric / nullif(v_lookback, 0))
              else                          exp(-v_decay_rate * rk)
            end) *
            (case when rk < v_boost_cutoff then v_boost_mult else 1.0 end)
          ) as freq_score,
          min(rk) as min_rk
        from (
          select unnest(hits) as num,
                 (row_number() over (order by game_num desc)) - 1 as rk
          from games
          where game_num < v_game.game_num
          order by game_num desc
          limit v_lookback
        ) expanded
        group by num
      ) scored
      order by
        (freq_score + case when min_rk > v_gap_threshold then v_gap_weight else 0.0 end) desc
      limit v_spot_count
    ) into v_picks;

    select count(*) into v_matches
    from unnest(v_picks) pk
    where pk = any(v_game.hits);

    v_prize := keno_prize(v_spot_count, v_matches);
    v_pnl   := v_prize - 1;

    v_te_pnl     := v_te_pnl + v_pnl;
    v_te_games   := v_te_games + 1;
    v_te_matches := v_te_matches + v_matches;
    if v_prize > 0 then
      v_te_wins   := v_te_wins + 1;
      v_te_streak := 0;
      if v_prize > v_te_best then v_te_best := v_prize; end if;
    else
      v_te_streak := v_te_streak + 1;
      if v_te_streak > v_te_max_streak then v_te_max_streak := v_te_streak; end if;
    end if;
  end loop;

  -- ---- LIVE P&L ----
  select count(*), coalesce(sum(pnl), 0)
  into v_live_count, v_live_total_pnl
  from live_results
  where strategy_id = p_strategy_id;

  v_live_ppg := case when v_live_count >= 10 then v_live_total_pnl / v_live_count else 0 end;

  -- ---- FITNESS SCORE ----
  v_test_ppg    := case when v_te_games > 0 then v_te_pnl / v_te_games else -1 end;
  v_win_rate    := case when (v_tr_games + v_te_games) > 0
                        then (v_tr_wins + v_te_wins)::numeric / (v_tr_games + v_te_games)
                        else 0 end;
  v_consistency := 1.0 / (1.0 + greatest(v_tr_max_streak, v_te_max_streak)::numeric / 10.0);

  select case when real_world_plays >= 10
              then real_world_pnl / real_world_plays * 1.5
              else 0 end
  into v_rw_bonus
  from strategies where id = p_strategy_id;

  v_fitness := (v_test_ppg  * 0.50)
             + (v_live_ppg  * 0.30)
             + (v_win_rate  * 0.10)
             + (v_consistency * 0.05)
             + (coalesce(v_rw_bonus, 0) * 0.05);

  -- ---- STORE RESULT ----
  insert into strategy_results (
    strategy_id, generation, spot_count,
    games_in_training, games_in_test,
    training_pnl, training_pnl_per_game,
    test_pnl, test_pnl_per_game,
    win_rate, avg_matches, best_single_win, max_losing_streak,
    fitness_score, picks_snapshot
  ) values (
    p_strategy_id,
    (select generation from strategies where id = p_strategy_id),
    v_spot_count,
    v_tr_games, v_te_games,
    v_tr_pnl, case when v_tr_games > 0 then v_tr_pnl / v_tr_games else 0 end,
    v_te_pnl, v_test_ppg,
    v_win_rate,
    case when (v_tr_games + v_te_games) > 0
         then (v_tr_matches + v_te_matches) / (v_tr_games + v_te_games) else 0 end,
    greatest(v_tr_best, v_te_best),
    greatest(v_tr_max_streak, v_te_max_streak),
    v_fitness,
    v_picks
  ) returning id into v_result_id;

  return jsonb_build_object(
    'fitness_score',      v_fitness,
    'test_pnl_per_game',  v_test_ppg,
    'win_rate',           v_win_rate,
    'max_losing_streak',  greatest(v_tr_max_streak, v_te_max_streak),
    'result_id',          v_result_id
  );
end;
$$ language plpgsql;

export interface StrategyGenome {
  lookback_games: number;
  weighting_method: 'raw' | 'linear_decay' | 'exponential_decay';
  decay_rate: number;
  recency_boost_cutoff: number;
  recency_boost_multiplier: number;
  gap_weight: number;
  gap_threshold: number;
  cluster_bias: number;
  bonus_correlation_weight: number;
  time_bias_weight: number;
  streak_weight: number;
  w_frequency: number;
  w_recency: number;
  w_gap: number;
  w_streak: number;
  w_bonus_corr: number;
  w_time: number;
}

export const GENOME_RANGES: Record<keyof StrategyGenome, [number | string, number | string]> = {
  lookback_games:           [50,   5000],
  weighting_method:         ['raw', 'exponential_decay'],
  decay_rate:               [0.001, 0.1],
  recency_boost_cutoff:     [1,    20],
  recency_boost_multiplier: [1.0,  5.0],
  gap_weight:               [0.0,  1.0],
  gap_threshold:            [5,    50],
  cluster_bias:             [-1.0, 1.0],
  bonus_correlation_weight: [0.0,  1.0],
  time_bias_weight:         [0.0,  1.0],
  streak_weight:            [0.0,  1.0],
  w_frequency:              [0.0,  1.0],
  w_recency:                [0.0,  1.0],
  w_gap:                    [0.0,  1.0],
  w_streak:                 [0.0,  1.0],
  w_bonus_corr:             [0.0,  1.0],
  w_time:                   [0.0,  1.0],
};

const WEIGHTING_METHODS: StrategyGenome['weighting_method'][] = [
  'raw', 'linear_decay', 'exponential_decay',
];

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

export function randomGenome(): StrategyGenome {
  return {
    lookback_games:           randInt(50, 5000),
    weighting_method:         WEIGHTING_METHODS[Math.floor(Math.random() * 3)],
    decay_rate:               rand(0.001, 0.1),
    recency_boost_cutoff:     randInt(1, 20),
    recency_boost_multiplier: rand(1.0, 5.0),
    gap_weight:               rand(0.0, 1.0),
    gap_threshold:            randInt(5, 50),
    cluster_bias:             rand(-1.0, 1.0),
    bonus_correlation_weight: rand(0.0, 1.0),
    time_bias_weight:         rand(0.0, 1.0),
    streak_weight:            rand(0.0, 1.0),
    w_frequency:              rand(0.0, 1.0),
    w_recency:                rand(0.0, 1.0),
    w_gap:                    rand(0.0, 1.0),
    w_streak:                 rand(0.0, 1.0),
    w_bonus_corr:             rand(0.0, 1.0),
    w_time:                   rand(0.0, 1.0),
  };
}

export function mutateGenome(
  genome: StrategyGenome,
  mutationRate: number,
  largeMutationProb: number,
  numParams = 2
): { genome: StrategyGenome; log: string[] } {
  const g = { ...genome };
  const log: string[] = [];

  const numericKeys = [
    'lookback_games', 'decay_rate', 'recency_boost_cutoff', 'recency_boost_multiplier',
    'gap_weight', 'gap_threshold', 'cluster_bias', 'bonus_correlation_weight',
    'time_bias_weight', 'streak_weight',
    'w_frequency', 'w_recency', 'w_gap', 'w_streak', 'w_bonus_corr', 'w_time',
  ] as (keyof StrategyGenome)[];

  // Pick random params to mutate
  const shuffled = [...numericKeys].sort(() => Math.random() - 0.5);
  const toMutate = shuffled.slice(0, numParams);

  // Maybe mutate weighting_method
  if (Math.random() < 0.15) {
    g.weighting_method = WEIGHTING_METHODS[Math.floor(Math.random() * 3)];
    log.push(`weighting_method → ${g.weighting_method}`);
  }

  for (const key of toMutate) {
    const range = GENOME_RANGES[key] as [number, number];
    const span = (range[1] as number) - (range[0] as number);
    const oldVal = g[key] as number;

    if (Math.random() < largeMutationProb) {
      // Full re-randomize
      const newVal = key === 'lookback_games' || key === 'recency_boost_cutoff' || key === 'gap_threshold'
        ? randInt(range[0] as number, range[1] as number)
        : rand(range[0] as number, range[1] as number);
      (g as any)[key] = newVal;
      log.push(`${key}: ${oldVal.toFixed ? oldVal.toFixed(3) : oldVal} → ${(newVal as number).toFixed ? (newVal as number).toFixed(3) : newVal} (full randomize)`);
    } else {
      // Small nudge
      const delta = (Math.random() * 2 - 1) * mutationRate * span;
      const newVal = Math.min(
        range[1] as number,
        Math.max(range[0] as number, (oldVal as number) + delta)
      );
      const rounded = key === 'lookback_games' || key === 'recency_boost_cutoff' || key === 'gap_threshold'
        ? Math.round(newVal)
        : newVal;
      (g as any)[key] = rounded;
      log.push(`${key}: ${(oldVal as number).toFixed(3)} → ${rounded.toFixed ? rounded.toFixed(3) : rounded} (±${(delta >= 0 ? '+' : '')}${delta.toFixed(3)})`);
    }
  }

  return { genome: g, log };
}

export function crossoverGenome(a: StrategyGenome, b: StrategyGenome): { genome: StrategyGenome; log: string[] } {
  const g = { ...a };
  const log: string[] = [];

  const keys = Object.keys(a) as (keyof StrategyGenome)[];
  for (const key of keys) {
    if (Math.random() < 0.5) {
      (g as any)[key] = b[key];
      log.push(`${key} ← parent B`);
    }
  }

  return { genome: g, log };
}

/** Render a genome as plain English for display. */
export function describeGenome(genome: StrategyGenome): string {
  const parts: string[] = [];

  parts.push(`Analyzes last ${genome.lookback_games} games`);

  if (genome.weighting_method === 'raw') {
    parts.push('weights all draws equally');
  } else if (genome.weighting_method === 'linear_decay') {
    parts.push(`fades older draws linearly`);
  } else {
    parts.push(`exponentially fades older draws (rate ${genome.decay_rate.toFixed(3)})`);
  }

  if (genome.recency_boost_multiplier > 1.5) {
    parts.push(`boosts last ${genome.recency_boost_cutoff} games by ${genome.recency_boost_multiplier.toFixed(1)}×`);
  }

  if (genome.gap_weight > 0.3) {
    parts.push(`strong overdue bias (threshold ${genome.gap_threshold} games)`);
  } else if (genome.gap_weight > 0.1) {
    parts.push(`light overdue bias`);
  }

  if (genome.bonus_correlation_weight > 0.4) {
    parts.push('heavy bonus correlation weighting');
  }

  const wSum = genome.w_frequency + genome.w_recency + genome.w_gap + genome.w_streak;
  if (wSum > 0) {
    const pct = (w: number) => Math.round((w / wSum) * 100);
    parts.push(
      `score mix: ${pct(genome.w_frequency)}% frequency / ${pct(genome.w_recency)}% recency / ${pct(genome.w_gap)}% gap / ${pct(genome.w_streak)}% streak`
    );
  }

  return parts.join(' · ');
}

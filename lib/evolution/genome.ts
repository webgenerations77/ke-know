export interface StrategyGenome {
  lookback_games: number;
  weighting_method: 'raw' | 'linear_decay' | 'exponential_decay';
  decay_rate: number;
  recency_boost_cutoff: number;
  recency_boost_multiplier: number;
  gap_weight: number;
  gap_threshold: number;
  bonus_type: 'none' | 'bonus' | 'super_bonus';
  hot_cold_balance: number;
  pick_noise: number;
  pair_weight: number;
  lookback_step: number;
  wager: number;
}

export function getWagerCost(genome: StrategyGenome): number {
  const base = genome.wager ?? 1;
  const multiplier = genome.bonus_type === 'super_bonus' ? 3 : genome.bonus_type === 'bonus' ? 2 : 1;
  return base * multiplier;
}

export const GENOME_RANGES: Record<keyof StrategyGenome, [number | string, number | string]> = {
  lookback_games:           [50,   500],
  weighting_method:         ['raw', 'exponential_decay'],
  decay_rate:               [0.001, 0.15],
  recency_boost_cutoff:     [1,    30],
  recency_boost_multiplier: [1.0,  5.0],
  gap_weight:               [0.0,  2.0],
  gap_threshold:            [3,    80],
  bonus_type:               ['none', 'super_bonus'],
  hot_cold_balance:         [-1.0, 1.0],
  pick_noise:               [0.0,  0.3],
  pair_weight:              [0.0,  1.0],
  lookback_step:            [1,    5],
  wager:                    [1,    5],
};

const WEIGHTING_METHODS: StrategyGenome['weighting_method'][] = [
  'raw', 'linear_decay', 'exponential_decay',
];

const BONUS_TYPES: StrategyGenome['bonus_type'][] = ['none', 'bonus', 'super_bonus'];

const INTEGER_KEYS = new Set<keyof StrategyGenome>([
  'lookback_games', 'recency_boost_cutoff', 'gap_threshold', 'lookback_step', 'wager',
]);

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

export function randomGenome(): StrategyGenome {
  return {
    lookback_games:           randInt(50, 500),
    weighting_method:         WEIGHTING_METHODS[Math.floor(Math.random() * 3)],
    decay_rate:               rand(0.001, 0.15),
    recency_boost_cutoff:     randInt(1, 30),
    recency_boost_multiplier: rand(1.0, 5.0),
    gap_weight:               rand(0.0, 2.0),
    gap_threshold:            randInt(3, 80),
    bonus_type:               BONUS_TYPES[Math.floor(Math.random() * 3)],
    hot_cold_balance:         rand(-1.0, 1.0),
    pick_noise:               rand(0.0, 0.3),
    pair_weight:              rand(0.0, 1.0),
    lookback_step:            randInt(1, 5),
    wager:                    randInt(1, 5),
  };
}

export function heuristicGenome(archetype: 'momentum' | 'contrarian' | 'balanced' | 'bonus_hunter', bonusOverride?: 'bonus' | 'super_bonus'): StrategyGenome {
  const base = randomGenome();
  switch (archetype) {
    case 'momentum':
      return {
        ...base,
        lookback_games: randInt(50, 80),
        weighting_method: 'exponential_decay',
        decay_rate: rand(0.05, 0.12),
        recency_boost_cutoff: randInt(5, 15),
        recency_boost_multiplier: rand(2.5, 4.5),
        gap_weight: rand(0.0, 0.3),
        hot_cold_balance: rand(0.5, 1.0),
        pick_noise: rand(0.0, 0.1),
      };
    case 'contrarian':
      return {
        ...base,
        lookback_games: randInt(150, 250),
        weighting_method: 'linear_decay',
        gap_weight: rand(1.0, 2.0),
        gap_threshold: randInt(10, 40),
        hot_cold_balance: rand(-1.0, -0.5),
        pick_noise: rand(0.0, 0.15),
      };
    case 'balanced':
      return {
        ...base,
        lookback_games: randInt(300, 500),
        weighting_method: 'raw',
        recency_boost_multiplier: rand(1.0, 2.0),
        gap_weight: rand(0.3, 0.8),
        hot_cold_balance: rand(-0.2, 0.2),
        pick_noise: rand(0.0, 0.05),
        pair_weight: rand(0.3, 0.7),
      };
    case 'bonus_hunter':
      return {
        ...base,
        bonus_type: bonusOverride ?? (Math.random() < 0.5 ? 'bonus' : 'super_bonus'),
      };
  }
}

const NUMERIC_KEYS: (keyof StrategyGenome)[] = [
  'lookback_games', 'decay_rate', 'recency_boost_cutoff', 'recency_boost_multiplier',
  'gap_weight', 'gap_threshold', 'hot_cold_balance', 'pick_noise', 'pair_weight', 'lookback_step',
  'wager',
];

export function mutateGenome(
  genome: StrategyGenome,
  mutationRate: number,
  largeMutationProb: number,
  numParams = 2
): { genome: StrategyGenome; log: string[] } {
  const g = { ...genome };
  const log: string[] = [];

  const shuffled = [...NUMERIC_KEYS].sort(() => Math.random() - 0.5);
  const toMutate = shuffled.slice(0, numParams);

  if (Math.random() < 0.15) {
    g.weighting_method = WEIGHTING_METHODS[Math.floor(Math.random() * 3)];
    log.push(`weighting_method -> ${g.weighting_method}`);
  }
  if (Math.random() < 0.20) {
    g.bonus_type = BONUS_TYPES[Math.floor(Math.random() * 3)];
    log.push(`bonus_type -> ${g.bonus_type}`);
  }

  for (const key of toMutate) {
    const range = GENOME_RANGES[key] as [number, number];
    const span = range[1] - range[0];
    const oldVal = (g[key] as number) ?? range[0];

    if (Math.random() < largeMutationProb) {
      const newVal = INTEGER_KEYS.has(key)
        ? randInt(range[0], range[1])
        : rand(range[0], range[1]);
      (g as any)[key] = newVal;
      log.push(`${key}: ${oldVal.toFixed(3)} -> ${newVal.toFixed(3)} (full randomize)`);
    } else {
      const delta = (Math.random() * 2 - 1) * mutationRate * span;
      let newVal = Math.min(range[1], Math.max(range[0], oldVal + delta));
      if (INTEGER_KEYS.has(key)) newVal = Math.round(newVal);
      (g as any)[key] = newVal;
      log.push(`${key}: ${oldVal.toFixed(3)} -> ${newVal.toFixed(3)} (delta ${delta >= 0 ? '+' : ''}${delta.toFixed(3)})`);
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
      log.push(`${key} <- parent B`);
    }
  }

  return { genome: g, log };
}

export function describeGenome(genome: StrategyGenome): string {
  const parts: string[] = [];

  parts.push(`Analyzes last ${genome.lookback_games} games`);

  if (genome.lookback_step > 1) {
    parts.push(`sampling every ${genome.lookback_step}${genome.lookback_step === 2 ? 'nd' : genome.lookback_step === 3 ? 'rd' : 'th'} game`);
  }

  if (genome.weighting_method === 'raw') {
    parts.push('weights all draws equally');
  } else if (genome.weighting_method === 'linear_decay') {
    parts.push('fades older draws linearly');
  } else {
    parts.push(`exponentially fades older draws (rate ${genome.decay_rate.toFixed(3)})`);
  }

  if (genome.recency_boost_multiplier > 1.5) {
    parts.push(`boosts last ${genome.recency_boost_cutoff} games by ${genome.recency_boost_multiplier.toFixed(1)}x`);
  }

  if (genome.gap_weight > 0.3) {
    parts.push(`strong overdue bias (threshold ${genome.gap_threshold} games)`);
  } else if (genome.gap_weight > 0.1) {
    parts.push('light overdue bias');
  }

  if (genome.hot_cold_balance > 0.3) {
    parts.push('momentum player (chases hot numbers)');
  } else if (genome.hot_cold_balance < -0.3) {
    parts.push('contrarian (prefers cold numbers)');
  }

  if (genome.pair_weight > 0.3) {
    parts.push('uses pair co-occurrence patterns');
  }

  if (genome.pick_noise > 0.1) {
    parts.push(`${(genome.pick_noise * 100).toFixed(0)}% pick randomization`);
  }

  const baseWager = genome.wager ?? 1;
  const bonusType = genome.bonus_type ?? 'none';
  if (bonusType === 'bonus') {
    parts.push(`$${baseWager} base + Bonus ($${baseWager * 2}/game)`);
  } else if (bonusType === 'super_bonus') {
    parts.push(`$${baseWager} base + Super Bonus ($${baseWager * 3}/game)`);
  } else if (baseWager > 1) {
    parts.push(`$${baseWager}/game wager`);
  }

  return parts.join(' · ');
}

/**
 * Length of the daily pick's play window, in minutes.
 *
 * Widened from 60 → 90 so all `recommended_games` (20) can realistically be
 * played in one sitting: MD Keno draws roughly every 4 minutes, so a 60-minute
 * window only fits ~14–15 games (Arthur was logging ~13–14/day). Ninety minutes
 * fits ~22 draws, comfortably covering a 20-game recommendation.
 *
 * Kept in a dependency-free module so both server routes and the client page can
 * import the single source of truth.
 */
export const DAILY_PICK_WINDOW_MINUTES = 90;

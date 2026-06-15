const EXTERNAL = 'https://api.prod.gkvmdl.mindgrb.io/v1/api/games/keno';

// Browser can't call the external API directly (no CORS headers).
// Use our proxy route when running client-side; call the API directly server-side.
function apiBase(): string {
  if (typeof window !== 'undefined') return '/api/lottery';
  return EXTERNAL;
}

export interface ApiDrawing {
  drawNumber: string;
  drawDate: string; // "MM/DD/YYYY"
  ingestedOn: string; // ISO
  results: {
    bonus: number;
    superBonus: number;
    hits: number[];
  };
}

export interface ApiResponse {
  drawings: ApiDrawing[];
}

export async function fetchDrawings(limit: number, start?: number): Promise<ApiDrawing[]> {
  const base = apiBase();
  const url = start != null
    ? `${base}?limit=${limit}&start=${start}`
    : `${base}?limit=${limit}&start=`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Lottery API ${res.status}: ${res.statusText}`);
  const data: ApiResponse = await res.json();
  return data.drawings ?? [];
}

export function parseDrawing(d: ApiDrawing) {
  const gameNum = parseInt(d.drawNumber, 10);
  const [month, day, year] = d.drawDate.split('/');
  const drawDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

  // Derive day-of-week from the actual draw date (reliable), not from ingestedOn
  const drawDow = new Date(`${drawDate}T12:00:00Z`).getUTCDay();

  return {
    game_num: gameNum,
    draw_date: drawDate,
    draw_iso: d.ingestedOn ?? null,
    draw_dow: drawDow,
    bonus: d.results.bonus ?? null,
    super_bonus: d.results.superBonus ?? null,
    hits: d.results.hits,
  };
}

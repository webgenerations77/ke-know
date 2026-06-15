import { NextRequest, NextResponse } from 'next/server';

const LOTTERY_API = 'https://api.prod.gkvmdl.mindgrb.io/v1/api/games/keno';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = searchParams.get('limit') ?? '100';
  const start = searchParams.get('start') ?? '';

  const url = `${LOTTERY_API}?limit=${limit}&start=${start}`;

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    return NextResponse.json(
      { error: `Lottery API ${res.status}` },
      { status: res.status }
    );
  }

  const data = await res.json();
  return NextResponse.json(data);
}

import { NextRequest, NextResponse } from 'next/server';
import Redis from 'ioredis';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  req.signal.addEventListener('abort', () => {
    redis.quit();
    writer.close();
  });

  redis.subscribe('vinted:new_items', (err) => {
    if (err) console.error('Redis subscribe error:', err);
  });

  redis.on('message', (channel, message) => {
    if (channel === 'vinted:new_items') {
      const data = `data: ${message}\n\n`;
      writer.write(encoder.encode(data));
    }
  });

  return new NextResponse(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}

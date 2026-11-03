import { env } from 'cloudflare:workers';
import { PROJECT_ID_PATTERN } from '@/lib/project-validation';

export const dynamic = 'force-dynamic';
const RESPONSE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!PROJECT_ID_PATTERN.test(id)) {
    return Response.json({ error: '프로젝트 공유 주소가 올바르지 않습니다.' }, { status: 400, headers: RESPONSE_HEADERS });
  }
  const bucket = env.BUCKET;
  if (!bucket) {
    return Response.json({ error: '공유 저장소에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.' }, { status: 503, headers: RESPONSE_HEADERS });
  }
  try {
    const snapshot = await bucket.get(`projects/${id.toLowerCase()}.json`);
    if (!snapshot) {
      return Response.json({ error: '저장된 프로젝트를 찾을 수 없습니다. 공유 링크를 확인해 주세요.' }, { status: 404, headers: RESPONSE_HEADERS });
    }
    return new Response(snapshot.body, {
      headers: { ...RESPONSE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(snapshot.size) },
    });
  } catch (error) {
    console.error('Project snapshot could not be loaded:', error instanceof Error ? error.name : 'unknown');
    return Response.json({ error: '프로젝트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 503, headers: RESPONSE_HEADERS });
  }
}

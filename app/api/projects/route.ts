import { env } from 'cloudflare:workers';
import { MAX_PROJECT_BYTES, type LastProject } from '@/lib/project';
import { ProjectValidationError, validateProject } from '@/lib/project-validation';

export const dynamic = 'force-dynamic';
const JSON_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function failure(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: JSON_HEADERS });
}

async function limitedBody(request: Request): Promise<string> {
  const advertised = request.headers.get('content-length');
  if (advertised && Number(advertised) > MAX_PROJECT_BYTES) {
    throw new ProjectValidationError('프로젝트 전체 크기는 30 MB 이하여야 합니다.', 'too-large');
  }
  if (!request.body) throw new ProjectValidationError('저장할 프로젝트가 없습니다.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_PROJECT_BYTES) {
        await reader.cancel();
        throw new ProjectValidationError('프로젝트 전체 크기는 30 MB 이하여야 합니다.', 'too-large');
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally { reader.releaseLock(); }
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    return failure('이 사이트에서 프로젝트를 저장해 주세요.', 403);
  }
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return failure('JSON 형식의 프로젝트가 필요합니다.', 415);
  }
  const bucket = env.BUCKET;
  if (!bucket) return failure('공유 저장소를 준비하고 있습니다. 우선 프로젝트를 파일로 내려받아 주세요.', 503);
  let project: LastProject;
  const savedAt = new Date().toISOString();
  try {
    const input: unknown = JSON.parse(await limitedBody(request));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProjectValidationError('프로젝트 정보가 올바르지 않습니다.');
    project = validateProject({ ...input, savedAt });
  } catch (error) {
    if (error instanceof ProjectValidationError) return failure(error.message, error.code === 'too-large' ? 413 : 400);
    return failure('프로젝트 JSON을 읽지 못했습니다. 파일 내용을 확인해 주세요.', 400);
  }
  try {
    const id = crypto.randomUUID();
    await bucket.put(`projects/${id}.json`, JSON.stringify(project), {
      httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' },
    });
    return Response.json({ id, savedAt }, { status: 201, headers: JSON_HEADERS });
  } catch (error) {
    console.error('Project snapshot could not be saved:', error instanceof Error ? error.name : 'unknown');
    return failure('프로젝트를 저장하지 못했습니다. 잠시 후 다시 시도하거나 파일로 내려받아 주세요.', 503);
  }
}

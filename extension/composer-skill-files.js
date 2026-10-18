import { SKILL_WRITE_SPECS, validateSkillWriteShape } from './skill-operation-specs.js';
import { validate } from './case-operation-specs.js';
import { sha256Blob } from './blob-digest.js';
import { AGENT_CHUNK_BYTES, base64ToBytes, bytesToBase64 } from './agent-protocol.js';

// Business rules stay shared; the workspace supplies file content rather than
// native-host paths. Binary input can come from read_skill_file's base64 data.
export const COMPOSER_SKILL_WRITE_SPECS = SKILL_WRITE_SPECS.map(spec => spec.name !== 'save_skill' ? spec : ({
  ...spec,
  description: '创作台files逐文件使用path和content；默认encoding=text，二进制用base64，可来自read_skill_file的data；插件自动分块传入。' + spec.description,
  parameters: { ...spec.parameters, properties: { ...spec.parameters.properties,
    files: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' },
        encoding: { enum: ['text', 'base64'] }, mimeType: { type: 'string' } }, required: ['path', 'content'] } }
  } }
}));

export async function prepareComposerSkillWrite(name, input, invokeTransfer, signal) {
  const spec = COMPOSER_SKILL_WRITE_SPECS.find(spec => spec.name === name);
  validate(spec.parameters, input, name);
  validateSkillWriteShape(input);
  if (!input.files) return input;
  const files = [];
  for (const file of input.files) {
    signal?.throwIfAborted();
    const path = file.path.replace(/\\/g, '/');
    const parts = [];
    if (file.encoding === 'base64') {
      const characters = AGENT_CHUNK_BYTES / 3 * 4;
      for (let offset = 0; offset < file.content.length; offset += characters) {
        parts.push(base64ToBytes(file.content.slice(offset, offset + characters)));
      }
    } else parts.push(file.content);
    const blob = new Blob(parts, { type: file.mimeType || 'application/octet-stream' });
    // Stable per-request file identity permits retry after lost acknowledgments.
    const id = `composer-skill-${await sha256Blob(new Blob([JSON.stringify([input.requestId, path])]))}`;
    const begun = await invokeTransfer('begin_transfer', { id, purpose: 'skill-file', name: path.split('/').at(-1),
      mimeType: blob.type, byteSize: blob.size, sha256: await sha256Blob(blob) });
    if (begun.state === 'uploading') {
      for (let offset = begun.offset; offset < blob.size;) {
        signal?.throwIfAborted();
        const bytes = new Uint8Array(await blob.slice(offset, offset + begun.chunkBytes).arrayBuffer());
        const next = await invokeTransfer('append_transfer', { id, offset, data: bytesToBase64(bytes) });
        offset = next.offset;
      }
    }
    signal?.throwIfAborted();
    await invokeTransfer('finish_transfer', { id });
    files.push({ path, transferId: id });
  }
  return { ...input, files };
}

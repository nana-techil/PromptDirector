import { CASE_OPERATION_SPECS, CASE_SEARCH_PROPERTIES } from './case-operation-specs.js';
import { CASE_QUERY_DESCRIPTION } from './case-query-specs.js';
import { PROJECT_OPERATION_SPECS, SAVE_TEXT_MATERIAL_SPEC } from './project-operation-specs.js';
import { WORKSPACE_OPERATION_SPECS } from './workspace-operation-specs.js';
import { WORKSPACE_SCREENSHOT_SPEC } from './workspace-screenshot-specs.js';
import { SKILL_OPERATION_SPECS, SKILL_WRITE_SPECS } from './skill-operation-specs.js';
import { ANALYSIS_BATCH_SPECS } from './analysis-batch-specs.js';

const id = { type: 'string', minLength: 1 }, offset = { type: 'integer', minimum: 0 };
const spec = (name, description, properties = {}, required = []) => ({ name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } });
// Browser and external Agents execute the same library operations. Host file
// transfers and destructive operations are not conversational library tools.
export const ASSISTANT_LIBRARY_SPECS = [
  ...CASE_OPERATION_SPECS, ...PROJECT_OPERATION_SPECS, SAVE_TEXT_MATERIAL_SPEC,
  ...WORKSPACE_OPERATION_SPECS, WORKSPACE_SCREENSHOT_SPEC,
  ...SKILL_OPERATION_SPECS, ...SKILL_WRITE_SPECS.filter(item => item.name === 'save_skill'),
  ...ANALYSIS_BATCH_SPECS,
  spec('describe_case_query', '读取案例库实际查询字段与条件说明。'),
  spec('search_cases', CASE_QUERY_DESCRIPTION, { ...CASE_SEARCH_PROPERTIES, offset,
    limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  spec('read_case', '读取实际案例正文/原词，按nextOffset与返回revision续读。编辑版本另用read_case_details取得。',
    { caseId: id, assetId: id, part: { enum: ['body', 'original_prompt', 'ai_prompt', 'time_notes', 'document', 'media_prompts', 'generation_info'] },
      expectedRevision: id, offset, length: { type: 'integer', minimum: 1, maximum: 49152 } }, ['caseId']),
  spec('read_media', '读取案例实际图片原件供当前模型观察；不支持视觉的模型不能看图。视频/音频返回真实媒体信息，不冒称看过视频。', { caseId: id, assetId: id }, ['caseId', 'assetId']),
  spec('show_case', '打开实际案例详情，保留人工草稿并等待现场就绪。', { caseId: id }, ['caseId']),
  spec('resolve_reference', '解析插件精确参考引用，不猜案例身份。', { reference: id }, ['reference']),
  spec('read_workspace_context', '读取插件已选参考概览。多个页面指定tabId，不将选区当授权。',
    { source: { enum: ['selection', 'page'] }, tabId: offset, expectedRevision: id, offset, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  spec('read_workspace_content', '按版本与nextOffset读取已选参考或页面草稿的完整内容，不读设置凭据。',
    { source: { enum: ['selection', 'page'] }, tabId: offset, expectedRevision: id,
      part: { enum: ['instruction', 'reference', 'selection'] }, referenceId: id, offset, length: { type: 'integer', minimum: 1, maximum: 49152 } }, ['part'])
];
export const assistantOperationName = name => name === 'search_cases' ? 'search' : name;

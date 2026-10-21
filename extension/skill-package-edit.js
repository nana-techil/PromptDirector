import { generatedSkillFiles, storedSkillFiles, parseSkillFiles } from './creative-skill-package.js';
import { currentCreativeSkillVersion } from './creative-skills.js';

// Reuse unchanged blobs and publish a complete file list with the new version.
// saveFile is owned by the caller's media stage, so failed saves remain recoverable.
export async function prepareSkillFileEdit({ skill, input, changes, readFile, saveFile }) {
  const cache = new Map();
  const read = id => { if (!cache.has(id)) cache.set(id, Promise.resolve(readFile(id))); return cache.get(id); };
  const original = skill ? await storedSkillFiles(skill, { readFile: read }) : new Map();
  let files;
  if (skill) {
    const draft = structuredClone(skill);
    draft.description = input.description;
    Object.assign(currentCreativeSkillVersion(draft), { skillMarkdown: input.skillMarkdown, provenanceMarkdown: input.provenanceMarkdown });
    files = await storedSkillFiles(draft, { readFile: read });
  } else files = generatedSkillFiles(input);
  for (const [path, blob] of changes) files.set(path, blob);
  const parsed = await parseSkillFiles(files);
  if (skill && parsed.name !== skill.portableId) throw new Error('包内 name 与现有 Skill 不同');
  const packageFiles = [];
  for (const [path, blob] of parsed.files) {
    const previous = skill?.packageFiles.find(file => file.path === path);
    // Cover validation may attach a MIME type without changing its bytes.
    const unchanged = previous && !changes.has(path) && files.get(path) === original.get(path);
    packageFiles.push(unchanged ? previous : await saveFile(path, blob));
  }
  return {
    portableId: parsed.name, description: parsed.description, skillMarkdown: parsed.body,
    references: parsed.references,
    provenanceMarkdown: parsed.references.find(ref => ref.path === 'references/provenance.md')?.markdown ?? '',
    packageFiles, runtimeDependencies: parsed.dependencies, textModeConfirmed: parsed.requiresTextModeConfirmation
  };
}

export function resolveSkillFileLink(from, href, paths) {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return null;
  try {
    const url = new URL(href, new URL(from, 'https://skill.invalid/'));
    const path = decodeURIComponent(url.pathname.slice(1));
    return paths.includes(path) ? { path, hash: decodeURIComponent(url.hash.slice(1)) } : null;
  } catch { return null; }
}

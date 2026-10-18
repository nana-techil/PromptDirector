import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createComposerSession, normalizeComposerAiProfile } from '../extension/composer.js';

const source = await readFile(process.env.PD_COMPOSER_SOURCE || new URL('../extension/composer-page.js', import.meta.url), 'utf8');
function functionSource(name, next) { return source.slice(source.indexOf(`async function ${name}`), source.indexOf(`\n${next}`, source.indexOf(`async function ${name}`))); }
const newSession = functionSource('createNewSession', 'function renderComposer');
const preferences = functionSource('updateComposerPreferences', 'async function loadComposerSession');
const profile = functionSource('updateComposerAiProfile', 'async function updateComposerOutputMode');
const retry = functionSource('retryComposerTurn', 'async function runComposerTurn');
function fixture(session = null) {
  const messages = [];
  const context = vm.createContext({
    composerSession: session, activeOperation: null, composerSettings: {lastTargetPlatform: 'legacy-explicit-model', outputLanguage: 'en', productionReviewEnabled: false, lastAiProfile: {serviceId:'deepseek', model:'deepseek-v4-pro', thinking:true}},
    composerAiTaskAssignments: {}, composerAiSettings: {}, composerVisionSettings: {}, composerDocumentTextByEntryId: {}, entries: [],
    createComposerSession, normalizeComposerAiProfile, normalizeComposerSettings: value => value,
    selectedTargetType: () => 'image', t: value => value, currentLocale: () => 'zh-CN',
    composerProfileForTaskAssignment: (_, previous) => previous, createReferenceSnapshots: () => [], isMeaningfulComposerSession: () => false,
    history: {replaceState() {}}, renderComposer() {}, closeComposerModelMenu() {}, composerFeedback() {},
    selectedComposerService: () => ({imageGeneration:true,videoGeneration:true}),
    elements: {composerProductionReview: {checked:session?.productionReviewEnabled ?? false}, composerInstruction: {focus() {}}},
    saveSession: async value => value, chrome: {runtime: {sendMessage: async value => {messages.push(value); return {ok:true};}}},
    lastCreativeJob: null, creativeJobs: {items: []}, confirmAppAction: async () => false, setActiveCreativeJob() {},
  });
  vm.runInContext([newSession, preferences, profile, retry].join('\n'), context);
  return {context, messages};
}

test('new UI conversations infer route and language without inheriting a former manually typed model, while preserving selected AI and review preferences', async () => {
  const {context} = fixture();
  await context.createNewSession();
  const s = context.composerSession;
  assert.equal(s.routeMode, 'auto'); assert.equal(s.outputLanguage, 'auto'); assert.equal(s.targetPlatform, '');
  assert.equal(s.aiProfile.model, 'deepseek-v4-pro'); assert.equal(s.aiProfile.thinking, true);
  assert.equal(s.productionReviewEnabled, false);
});

test('editing visible switches preserves explicit parameters and an unchanged retry plan in a previously saved conversation', async () => {
  const original = createComposerSession({targetPlatform:'Explicit shared model', outputLanguage:'en', routeMode:'compose', productionReviewEnabled:true,
    aiProfile:{serviceId:'deepseek',model:'deepseek-v4-pro'}, currentInstruction:'Preserve this retry instruction', currentRoute:'compose', currentRouteSource:'manual'});
  const {context, messages} = fixture(original);
  await context.updateComposerPreferences();
  assert.equal(context.composerSession.currentInstruction, original.currentInstruction);
  await context.updateComposerAiProfile({thinking:true});
  for(const key of ['targetPlatform','outputLanguage','routeMode','currentInstruction','currentRoute','currentRouteSource']) assert.equal(context.composerSession[key],original[key]);
  assert.equal(context.composerSession.aiProfile.thinking, true);
  context.elements.composerProductionReview.checked=false;
  await context.updateComposerPreferences();
  assert.equal(context.composerSession.productionReviewEnabled,false);
  for(const key of ['targetPlatform','outputLanguage','routeMode']) assert.equal(context.composerSession[key],original[key]);
  assert.ok(messages.every(message => !('lastTargetPlatform' in message) && !('outputLanguage' in message)));
});

test('compact settings retain paid-job retry confirmation and never silently retry a paid generation', async () => {
  const session=createComposerSession({id:'existing', targetPlatform:'Shared target', outputLanguage:'en', routeMode:'compose', outputMode:'create_image'});
  session.lastFailure={userMessageId:'request',retryable:true};
  const {context,messages}=fixture(session);
  context.lastCreativeJob={id:'failed-job',sessionId:session.id,userMessageId:'request',status:'failed',error:{retryable:true}};
  let confirmed=0;
  context.confirmAppAction=async info=>{assert.match(info.description,/费用|计费/);confirmed++;return false;};
  await context.retryComposerTurn();assert.equal(confirmed,1);assert.equal(messages.length,0);
  assert.equal(context.composerSession,session);
  context.confirmAppAction=async()=>true;
  context.chrome.runtime.sendMessage=async message=>{messages.push(message);return {ok:true,job:{id:'retry-job'}};};
  await context.retryComposerTurn();
  assert.equal(messages[0].type,'RETRY_CREATIVE_JOB');assert.equal(messages[0].jobId,'failed-job');
  assert.equal(context.composerSession.targetPlatform,'Shared target');assert.equal(context.composerSession.outputLanguage,'en');
});

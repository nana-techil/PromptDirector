import { buildComposerDiagnostic } from './composer-diagnostics.js';
import { agentContextValue } from './agent-runtime-context.js';

// Readable text is intentional; credentials and media payloads are not diagnostics.
export const captureDiagnosticValue = value => agentContextValue(value, { omitInlineMedia: true });

export function buildCaptureDiagnostic(store, current) {
  const sessions = [...store.history, ...(store.conversations || Object.values(store.pages))].map(session => captureDiagnosticValue(session));
  const diagnostic = buildComposerDiagnostic({ id: current.id, title: current.pageTitle, outputLanguage: current.locale,
    messages: current.messages, diagnosticEvents: current.events || [], lastFailure: current.lastError ? { message: current.lastError } : null });
  return captureDiagnosticValue({ ...diagnostic, surface: 'capture-assistant', capture: { activeUrl: store.activeUrl, sessions, pageWork: store.pages } });
}

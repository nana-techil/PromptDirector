import { buildComposerDiagnostic } from './composer-diagnostics.js';

// Readable text is intentional; credentials and media payloads are not diagnostics.
export function captureDiagnosticValue(value) {
  if (typeof value === 'string') return value.replace(/data:[^\s"']+;base64,[A-Za-z0-9+/=]+/gu, '[media payload omitted]');
  if (Array.isArray(value)) return value.map(captureDiagnosticValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:apiKey|authorization|password|secret|accessToken|refreshToken|dataUrl|base64|bytes)$/iu.test(key))
    .map(([key, item]) => [key, captureDiagnosticValue(item)]));
}

export function buildCaptureDiagnostic(store, current) {
  const sessions = [...store.history, ...Object.values(store.pages)].map(session => captureDiagnosticValue(session));
  const diagnostic = buildComposerDiagnostic({ id: current.id, title: current.pageTitle, outputLanguage: current.locale,
    messages: current.messages, diagnosticEvents: current.events || [], lastFailure: current.lastError ? { message: current.lastError } : null });
  return captureDiagnosticValue({ ...diagnostic, surface: 'capture-assistant', capture: { activeUrl: store.activeUrl, sessions } });
}

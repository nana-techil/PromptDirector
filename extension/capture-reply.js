// Limit the visible conversational reply, never the saved sources or diagnostic
// record. Long explanations remain available deliberately via an expansion.
export const CAPTURE_REPLY_CHARACTERS = 120;
export function compactCaptureReply(text = '') {
  const characters = Array.from(text.trim());
  if (characters.length <= CAPTURE_REPLY_CHARACTERS) return { brief: text, overflow: false };
  const prefix = characters.slice(0, CAPTURE_REPLY_CHARACTERS - 1).join('');
  const lastSentence = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('！'), prefix.lastIndexOf('？'), prefix.lastIndexOf('. '));
  return { brief: (lastSentence >= prefix.length / 2 ? prefix.slice(0, lastSentence + 1) : prefix) + '…', overflow: true };
}

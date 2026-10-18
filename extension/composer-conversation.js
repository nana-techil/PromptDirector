// Preserve provider roles across turns. Only the current user message receives current attachments.
export function applyComposerConversation(body, request, protocol='chat_completions') {
  const history=(request.messages??[]).filter(message=>['user','assistant'].includes(message.role) && String(message.content??'').trim())
    .map(({role,content})=>({role,content:String(content)}));
  const latest=history.at(-1)?.role==='user' ? history.pop().content : String(request.instruction??'');
  const {messages: _messages,...context}=request;
  const sequence=protocol==='responses'?body.input:body.messages;
  const current=sequence.at(-1);
  const content=Array.isArray(current.content)?current.content:[{type:protocol==='responses'?'input_text':'text',text:String(current.content)}];
  content[0]={...content[0],text:JSON.stringify(context)};
  if(latest) content.push({type:protocol==='responses'?'input_text':'text',text:latest});
  const currentMessage={role:'user',content};
  const prefix=protocol==='responses'?[]:sequence.filter(message=>message.role==='system');
  const result=[...prefix,...history,currentMessage];
  if(protocol==='responses') body.input=result;
  else body.messages=result;
  return body;
}

// The assistant owns execution policy. A composer route is only presentation
// metadata here; carrying its chat-only method contradicts native tool work.
// Project only the structured context built above, never human message text.
export function removeComposerRouting(body, protocol) {
  for (const message of protocol === 'responses' ? body.input : body.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const [index, part] of message.content.entries()) {
      if (!part?.text) continue;
      let value;
      try { value = JSON.parse(part.text); } catch { continue; }
      if (!value || !Object.hasOwn(value, 'methodVersion') || !Object.hasOwn(value, 'agentVersion') || !Object.hasOwn(value, 'taskMethod')) continue;
      const { routeMode, route, taskMethod, ...context } = value;
      message.content[index] = { ...part, text: JSON.stringify(context) };
      break;
    }
  }
}

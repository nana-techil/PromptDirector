"""Video/offscreen tools use real worker dispatch and preserve canonical user work."""
import json

from e2e_support import base_entry, extension_session


def main():
    original = '保留完整原词。' * 1000
    videos = []
    for entry_id, duration, prompt in [('prompted', 8000, '独立视频原词'),
                                       ('unprompted', 12000, ''), ('unknown-duration', None, '')]:
        entry = base_entry(entry_id, f'时长覆盖 {entry_id}', '', 'content:prompt:video', 2)
        asset_id = f'{entry_id}-video'
        entry['mediaAssets'] = [{'id': asset_id, 'kind': 'video', 'mimeType': 'video/mp4',
                                 'storageMode': 'managed', **({'durationMs': duration} if duration else {})}]
        if prompt:
            entry['mediaPrompts'] = [{'assetId': asset_id, 'source': 'manual', 'text': prompt}]
        videos.append(entry)
    with extension_session('pd-composer-worker-tools-') as run:
        page = run.open_page('collector.html')
        run.seed_storage(page, {'entries': [base_entry('bridge-case', '工具读取案例', original,
                                                     'content:prompt:image', 1), *videos]})
        skill = page.evaluate("""async () => {
          const response = await chrome.runtime.sendMessage({type:'CREATE_CREATIVE_SKILL',
            skill:{callName:'完整方法',description:'后台工具回归',skillMarkdown:'保留完整方法正文'}});
          if (!response.ok) throw Error(response.message);
          const {createComposerSession}=await import('./composer.js');
          await (await import('./library-storage.js')).getLibraryStorage().set({composerSessions:[createComposerSession({id:'bridge-session',
            libraryTools:{candidates:[{caseId:'bridge-case',title:'工具读取案例'}]},
            messages:[{id:'request',role:'user',content:'读取参考'},
                      {id:'other-request',role:'user',content:'另一个任务'}],
            toolContinuations:{'other-request':{protocol:'chat_completions',
              body:{model:'fixture-model'},marker:'保留另一个任务'}}})]});
          return response.skill;
        }""")

        def call(operation, value):
            result = page.evaluate("""async ([operation,input]) => chrome.runtime.sendMessage({
              type:'COMPOSER_LIBRARY_HOST',operation,input,sessionId:'bridge-session',userMessageId:'request'})""",
                                   [operation, value])
            assert result['ok'], result
            return result

        def execute(name, args):
            result = call('execute', {'name': name, 'args': args, 'callId': name})
            data = result['data']['data']
            assert not data.get('error'), result
            assert [event['status'] for event in result['events']] == ['running', 'completed'], result
            return data

        found = execute('search_cases', {'query': '工具读取案例'})
        assert any(item['caseId'] == 'bridge-case' for item in found['candidates']), found
        for has_prompt, expected_id in [(True, 'prompted'), (False, 'unprompted')]:
            duration_result = execute('search_cases', {'query': '时长覆盖', 'mediaKind': 'video',
                                                      'minDurationMs': 5000, 'hasPrompt': has_prompt})
            assert [item['caseId'] for item in duration_result['candidates']] == [expected_id], duration_result
            coverage = duration_result['durationCoverage']
            assert (coverage['totalMedia'], coverage['knownDurationMedia'], coverage['unknownDurationMedia']) == (3, 2, 1), duration_result
        overview = execute('read_case_details', {'caseId': 'bridge-case'})
        document = execute('read_case_details', {'caseId': 'bridge-case', 'part': 'document',
                                               'expectedRevision': overview['revision'], 'length': 12000})
        assert original in document['content'], document
        assert document['nextOffset'] is None and document['revision'] == overview['revision'], document
        method = execute('read_skill', {'skillId': skill['id']})
        assert method['content'] == '保留完整方法正文', method

        call('recordToolResult', {'callId':'actual-read','name':'read_case_details','args':{'caseId':'bridge-case'},'data':document})
        page.reload()
        facts = call('loadContext', None)['data']
        assert len(facts)==1 and original in facts[0]['data']['content'], facts

        checkpoint = {'protocol': 'chat_completions', 'body': {'model': 'fixture-model'}, 'nextOffset': 7000}
        call('saveContinuation', checkpoint)
        page.reload()
        assert call('loadContinuation', {'model': 'fixture-model', 'protocol': 'chat_completions'})['data'] == checkpoint
        call('clearContinuation', None)
        assert call('loadContinuation', {'model': 'fixture-model', 'protocol': 'chat_completions'})['data'] is None
        stored = page.evaluate("async () => import(chrome.runtime.getURL('library-storage.js')).then(({getLibraryStorage}) => getLibraryStorage().get(['entries','composerSessions']))")
        assert original in json.dumps(stored['entries'], ensure_ascii=False)
        assert stored['composerSessions'][0]['toolContinuations']['other-request']['marker'] == '保留另一个任务'
        assert not run.page_errors, run.page_errors
        print(json.dumps({'workerCaseRead': True, 'workerSearch': True, 'workerSkillRead': True,
                          'durationCoverageBeforePromptFilter': True,
                          'continuationReload': True, 'otherTaskPreserved': True, 'sharedOriginalContextReload':True}, ensure_ascii=False))


if __name__ == '__main__':
    main()

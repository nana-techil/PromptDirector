from __future__ import annotations

import time

from e2e_support import extension_session, wait_for_async_condition


def wait_for_job(page, job_id: str, statuses: set[str], timeout_seconds: float = 8) -> dict:
    deadline = time.monotonic() + timeout_seconds
    response = None
    while time.monotonic() < deadline:
        response = page.evaluate(
            "(jobId) => chrome.runtime.sendMessage({type: 'GET_IMPORT_JOB', jobId})",
            job_id,
        )
        if response.get("job", {}).get("status") in statuses:
            return response["job"]
        page.wait_for_timeout(100)
    raise AssertionError(f"导入任务没有在期限内进入 {statuses}：{response}")


def wait_for_local_palette(page, asset_id: str, timeout_seconds: float = 8) -> dict:
    deadline = time.monotonic() + timeout_seconds
    metadata = None
    while time.monotonic() < deadline:
        metadata = page.evaluate(
            """async (assetId) => {
              const store = await import(chrome.runtime.getURL('media-store.js'));
              return store.getDerivedMetadata(assetId);
            }""",
            asset_id,
        )
        if metadata and metadata.get("palette", {}).get("colors"):
            return metadata
        page.wait_for_timeout(100)
    raise AssertionError(f"导入图片没有自动生成本地色卡：{metadata}")


def main() -> None:
    with extension_session("prompt-director-import-jobs-", viewport={"width": 1280, "height": 900}) as run:
        starter = run.open_page("collector.html")
        run.seed_storage(starter, {"schemaVersion": 24, "entries": []})

        started = starter.evaluate(
            """async () => {
              const media = await import(chrome.runtime.getURL('media-store.js'));
              const canvas = new OffscreenCanvas(64, 64);
              const context = canvas.getContext('2d');
              context.fillStyle = '#e24b32';
              context.fillRect(0, 0, 64, 64);
              const colorBlob = await canvas.convertToBlob({type: 'image/png'});
              const assets = [
                {
                  id: 'staged:first', assetId: 'asset:first', name: 'first.txt',
                  relativePath: 'notes/first.txt', kind: 'document', mimeType: 'text/plain',
                  byteSize: 10, contentText: 'First note'
                },
                {
                  id: 'staged:second', assetId: 'asset:second', name: 'second.md',
                  relativePath: 'notes/second.md', kind: 'document', mimeType: 'text/markdown',
                  byteSize: 11, contentText: 'Second note'
                },
                {
                  id: 'staged:color', assetId: 'asset:color', name: 'color.png',
                  relativePath: 'images/color.png', kind: 'image', mimeType: 'image/png',
                  byteSize: colorBlob.size, width: 64, height: 64
                }
              ];
              await media.saveMediaBlob('asset:first', new Blob(['First note'], {type: 'text/plain'}));
              await media.saveMediaBlob('asset:second', new Blob(['Second note'], {type: 'text/markdown'}));
              await media.saveMediaBlob('asset:color', colorBlob);
              return chrome.runtime.sendMessage({
                type: 'START_IMPORT_JOB',
                stagedAssets: assets,
                items: assets.map(asset => ({stagedAssetId: asset.id, keepDuplicate: false})),
                options: {autoAnalyze: false}
              });
            }"""
        )
        assert started["ok"], started
        first_job_id = started["job"]["id"]
        starter.close()

        observer = run.open_page("collector.html")
        completed = wait_for_job(observer, first_job_id, {"completed"})
        assert [item["status"] for item in completed["items"]] == ["imported", "imported", "imported"], completed
        imported_ids = completed["createdEntryIds"]
        assert len(imported_ids) == 3, completed
        palette = wait_for_local_palette(observer, "asset:color")
        automatic_ai_job = observer.evaluate("() => chrome.storage.local.get('automaticVisionBatchJob').then(value => value.automaticVisionBatchJob || null)")
        assert automatic_ai_job is None, automatic_ai_job

        undo = observer.evaluate(
            "(jobId) => chrome.runtime.sendMessage({type: 'UNDO_IMPORT_JOB', jobId})",
            first_job_id,
        )
        assert undo["ok"], undo
        entries_after_undo = observer.evaluate("() => import(chrome.runtime.getURL('library-storage.js')).then(({getLibraryStorage}) => getLibraryStorage().get('entries')).then(value => value.entries || [])")
        assert not entries_after_undo, entries_after_undo

        canceled = observer.evaluate(
            """async () => {
              const media = await import(chrome.runtime.getURL('media-store.js'));
              const jobs = await import(chrome.runtime.getURL('import-jobs.js'));
              const stagingApi = await import(chrome.runtime.getURL('import-staging.js'));
              const blob = new Blob(['cancel me'], {type: 'text/plain'});
              await media.saveMediaBlob('asset:cancel-a', blob);
              await media.saveMediaBlob('asset:cancel-b', blob);
              let staging = stagingApi.addStagedAsset(undefined, {
                id: 'staged:cancel-a', assetId: 'asset:cancel-a', name: 'cancel-a.txt',
                relativePath: 'cancel-a.txt', kind: 'document', mimeType: 'text/plain', byteSize: blob.size,
                contentHash: 'a'.repeat(64)
              }).state;
              staging = stagingApi.addStagedAsset(staging, {
                id: 'staged:cancel-b', assetId: 'asset:cancel-b', name: 'cancel-b.txt',
                relativePath: 'cancel-b.txt', kind: 'document', mimeType: 'text/plain', byteSize: blob.size,
                contentHash: 'b'.repeat(64)
              }).state;
              const current = await chrome.storage.local.get('importJobs');
              const created = jobs.createImportJob(current.importJobs, {
                items: [{stagedAssetId: 'staged:cancel-a'}, {stagedAssetId: 'staged:cancel-b'}],
                options: {autoAnalyze: false}
              }, {id: 'import-job:cancel'});
              await chrome.storage.local.set({importJobs: created.state, importStaging: staging});
              return chrome.runtime.sendMessage({type: 'CANCEL_IMPORT_JOB', jobId: created.job.id});
            }"""
        )
        assert canceled["ok"], canceled
        assert canceled["job"]["status"] == "canceled", canceled
        assert all(item["status"] == "skipped" and item["skipReason"] == "canceled" for item in canceled["job"]["items"]), canceled

        # Cancel must retire unused handles, preserve other pending references,
        # and leave the user's original files intact.
        linked_cleanup = observer.evaluate(
            """async () => {
              const local = await import(chrome.runtime.getURL('local-asset-store.js'));
              const jobs = await import(chrome.runtime.getURL('import-jobs.js'));
              const stagingApi = await import(chrome.runtime.getURL('import-staging.js'));
              const root = await navigator.storage.getDirectory();
              const originals = [];
              const stored = await chrome.storage.local.get(['importJobs', 'importStaging']);
              let staging = stored.importStaging;
              const assets = [];
              for (const name of ['unused', 'shared']) {
                const handle = await root.getFileHandle(name + '.zzz', {create: true});
                const writable = await handle.createWritable();
                await writable.write('original-' + name); await writable.close();
                const file = await handle.getFile();
                const assetId = 'asset:linked-' + name;
                await local.saveLocalAssetHandle(assetId, handle, file);
                originals.push(handle);
                const asset = {id: 'staged:linked-' + name, assetId, name: file.name,
                  relativePath: file.name, kind: 'attachment', mimeType: 'application/octet-stream',
                  byteSize: file.size, sourceLastModified: file.lastModified,
                  recordType: 'local-asset-reference', storageMode: 'reference', linkStatus: 'linked',
                  importFailure: {code: 'unsupported_format', message: 'Unsupported fixture', forceAllowed: false}};
                assets.push(asset); staging = stagingApi.addStagedAsset(staging, asset).state;
              }
              const retainedStageId = 'staged:linked-other-owner';
              staging = stagingApi.addStagedAsset(staging, {...assets[1], id: retainedStageId}).state;
              const created = jobs.createImportJob(stored.importJobs, {
                items: assets.map(asset => ({stagedAssetId: asset.id})), options: {autoAnalyze: false}
              }, {id: 'import-job:linked-cancel'});
              await chrome.storage.local.set({importJobs: created.state, importStaging: staging});
              const response = await chrome.runtime.sendMessage({type: 'CANCEL_IMPORT_JOB', jobId: created.job.id});
              const after = await chrome.storage.local.get('importStaging');
              return {response, remaining: after.importStaging.assets.map(asset => asset.id), retainedStageId,
                unusedRetained: !!await local.getLocalAssetHandleRecord(assets[0].assetId),
                sharedRetained: !!await local.getLocalAssetHandleRecord(assets[1].assetId),
                originals: await Promise.all(originals.map(async handle => (await handle.getFile()).text()))};
            }"""
        )
        assert linked_cleanup["response"]["ok"], linked_cleanup
        assert linked_cleanup["response"]["job"]["status"] == "canceled", linked_cleanup
        assert linked_cleanup["remaining"] == [linked_cleanup["retainedStageId"]], linked_cleanup
        assert not linked_cleanup["unusedRetained"] and linked_cleanup["sharedRetained"], linked_cleanup
        assert linked_cleanup["originals"] == ["original-unused", "original-shared"], linked_cleanup

        # Releasing preparation retires only the unused handle, never the source
        # file or the handle still owned by another import.
        released = observer.evaluate(
            """async () => {
              const {createMediaStage} = await import(chrome.runtime.getURL('staged-media.js'));
              const {saveLocalAssetHandle, getLocalAssetHandleRecord} = await import(chrome.runtime.getURL('local-asset-store.js'));
              const root = await navigator.storage.getDirectory();
              const handle = await root.getFileHandle('preview-only.zzz', {create: true});
              const writable = await handle.createWritable();
              await writable.write('preview-original'); await writable.close();
              await saveLocalAssetHandle('asset:linked-preview', handle, await handle.getFile());
              const stage = createMediaStage();
              await stage.register(['asset:linked-shared', 'asset:linked-preview'], ['asset:linked-shared', 'asset:linked-preview']);
              stage.release();
              return !!await getLocalAssetHandleRecord('asset:linked-shared');
            }"""
        )
        assert released, "releasing a preview must preserve a handle still owned by another import"
        wait_for_async_condition(observer,
            "async () => !Object.keys((await chrome.storage.local.get('stagedMediaWrites')).stagedMediaWrites || {}).length"
        )
        retired = observer.evaluate("""async () => {
          const local = await import('./local-asset-store.js');
          const root = await navigator.storage.getDirectory();
          return {shared: !!await local.getLocalAssetHandleRecord('asset:linked-shared'),
            unused: !!await local.getLocalAssetHandleRecord('asset:linked-preview'),
            original: await (await (await root.getFileHandle('preview-only.zzz')).getFile()).text()};
        }""")
        assert retired == {"shared": True, "unused": False, "original": "preview-original"}, retired

        failed_job_id = observer.evaluate(
            """async () => {
              const jobs = await import(chrome.runtime.getURL('import-jobs.js'));
              const stagingApi = await import(chrome.runtime.getURL('import-staging.js'));
              const stored = await chrome.storage.local.get(['importJobs', 'importStaging']);
              const staging = stagingApi.addStagedAsset(stored.importStaging, {
                id: 'staged:retry', assetId: 'asset:retry', name: 'retry.txt',
                relativePath: 'retry.txt', kind: 'document', mimeType: 'text/plain', byteSize: 10,
                contentHash: 'c'.repeat(64), contentText: 'Retry note'
              }).state;
              const created = jobs.createImportJob(stored.importJobs, {
                items: [{stagedAssetId: 'staged:retry'}], options: {autoAnalyze: false}
              }, {id: 'import-job:failure'});
              await chrome.storage.local.set({importJobs: created.state, importStaging: staging});
              await chrome.alarms.create('prompt-director-local-import', {when: Date.now()});
              return created.job.id;
            }"""
        )
        failed = wait_for_job(observer, failed_job_id, {"failed"})
        assert len(failed["items"]) == 1 and failed["items"][0]["status"] == "failed", failed

        retry = observer.evaluate(
            """async (jobId) => {
              const media = await import(chrome.runtime.getURL('media-store.js'));
              await media.saveMediaBlob('asset:retry', new Blob(['Retry note'], {type: 'text/plain'}));
              return chrome.runtime.sendMessage({type: 'RETRY_IMPORT_JOB', jobId});
            }""",
            failed_job_id,
        )
        assert retry["ok"], retry
        assert retry["job"]["retryOf"] == failed_job_id and len(retry["job"]["items"]) == 1, retry
        retried = wait_for_job(observer, retry["job"]["id"], {"completed"})
        assert retried["items"][0]["status"] == "imported", retried

        retry_undo = observer.evaluate(
            "(jobId) => chrome.runtime.sendMessage({type: 'UNDO_IMPORT_JOB', jobId})",
            retry["job"]["id"],
        )
        assert retry_undo["ok"], retry_undo
        final_entries = observer.evaluate("() => import(chrome.runtime.getURL('library-storage.js')).then(({getLibraryStorage}) => getLibraryStorage().get('entries')).then(value => value.entries || [])")
        assert not final_entries, final_entries

        print({
            "continuedAfterPageClose": True,
            "multiFileImported": len(imported_ids),
            "automaticLocalPalette": palette["palette"]["colors"][0],
            "automaticAiJob": automatic_ai_job,
            "canceledRemaining": len(canceled["job"]["items"]),
            "linkedCancelRetiresUnusedProtectsSharedAndOriginals": True,
            "releasedLinkedPreviewProtectsSharedHandle": True,
            "retriedFailedOnly": len(retry["job"]["items"]),
            "undoScopedToJob": True,
        })


if __name__ == "__main__":
    main()

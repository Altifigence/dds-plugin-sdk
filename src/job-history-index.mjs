import {JOB_HISTORY_LIMITS, parseJobHistoryQuery, parseJobHistoryItem, parseJobHistoryPage} from './job-history.mjs';
import {ErrorCode, PluginSdkError} from './limits.mjs';
import {hostRuntime} from './host-runtime.mjs';

const failure = code => new PluginSdkError(code, 'Job history operation failed');
/** Snapshot membership/order; current authorization and removal are checked per page. */
export function createJobHistoryIndex(scope, identity, artifactFor, authorizedRecords, isLive,runtimeInput) {
  const runtime=hostRuntime(runtimeInput);
  const views = new Map();
  return (pluginId, query, grants, commands) => {
    query = parseJobHistoryQuery(query);
    const now = runtime.now(), {cursor, ...filters} = query;
    const signature = JSON.stringify(Object.fromEntries(Object.entries(filters).sort(([a],[b]) => a.localeCompare(b))));
    for (const [id, view] of views) if (view.expiresAt <= now) views.delete(id);
    const current = new Map(authorizedRecords(pluginId, grants, commands).map(record => [record.snapshot.jobId, record]));
    let view, viewId, offset = 0;
    if (cursor !== undefined) {
      [viewId] = cursor.split(':'); offset = Number(cursor.split(':')[1]); view = views.get(viewId);
      if (!view || view.pluginId !== pluginId || view.signature !== signature || offset > view.items.length) throw failure(ErrorCode.CONFLICT);
    } else {
      const items = [];
      for (const record of current.values()) {
        const s = record.snapshot;
        const disposition = record.expiresAt <= now ? 'expired' : record.settled ? 'completed' : isLive(s.jobId) ? 'live' : 'interrupted';
        if (filters.state !== undefined && filters.state !== s.state || filters.disposition !== undefined && filters.disposition !== disposition || filters.commandId !== undefined && filters.commandId !== s.commandId || filters.from !== undefined && s.startedAt < filters.from || filters.to !== undefined && s.startedAt > filters.to || filters.attemptOf !== undefined && record.attemptOf !== filters.attemptOf) continue;
        const artifactCount = s.artifacts.length + record.binaryArtifacts.length;
        const snapshotCount=record.retainedArtifacts?.length??0;
        items.push(parseJobHistoryItem({jobId:s.jobId,commandId:s.commandId,state:s.state,disposition,startedAt:s.startedAt,updatedAt:s.updatedAt,expiresAt:record.expiresAt,revision:record.revision,attemptOf:record.attemptOf ?? null,contentPolicy:record.contentPolicy,artifactCount,snapshotCount,resultAvailability:disposition==='expired'?'expired':!artifactCount?'none':!snapshotCount?'source-references':snapshotCount===artifactCount?'snapshot-references':'mixed-references'}));
      }
      items.sort((a,b) => b.startedAt-a.startedAt || a.jobId.localeCompare(b.jobId));
      view = {pluginId, signature, asOf:now, expiresAt:now + JOB_HISTORY_LIMITS.cursorMs, items};
      viewId = runtime.randomUUID();
      if (items.length > filters.limit) {
        if (views.size >= JOB_HISTORY_LIMITS.snapshots) throw failure(ErrorCode.BUDGET_EXCEEDED);
        views.set(viewId, view);
      }
    }
    const items = [];
    while (offset < view.items.length && items.length < filters.limit) {
      const item = view.items[offset++], record = current.get(item.jobId);
      if (!record) continue;
      // A pruned/reused ID is not the original member of this snapshot.
      if (record.snapshot.startedAt !== item.startedAt) continue;
      items.push(record.expiresAt <= now ? {...item,disposition:'expired',resultAvailability:'expired'} : item);
    }
    return parseJobHistoryPage({protocolVersion:1,scope,storeId:identity.storeId,pluginId,pluginArtifactSha256:artifactFor(pluginId),asOf:view.asOf,expiresAt:view.expiresAt,items,nextCursor:offset < view.items.length ? `${viewId}:${offset}` : null});
  };
}

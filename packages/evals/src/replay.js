export function replayTask(events, taskId) {
  const rows=events.filter((e)=>e.task_id===taskId);
  if (!rows.length) return null;
  const task=rows.find((e)=>e.event_type==="task_snapshot") ?? null;
  const catalogs=rows.filter((e)=>e.event_type==="catalog_snapshot");
  return {
    taskId,
    taskSnapshot: task?.payload ?? null,
    catalogSnapshot: catalogs.at(-1)?.payload ?? null,
    events: rows,
    observations: rows.filter((e)=>e.event_type==="execution_observation"),
    receipts: rows.filter((e)=>e.event_type==="execution_receipt"),
  };
}

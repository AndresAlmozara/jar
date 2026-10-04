import { OpenCodeObserver } from "./observer.js";

/**
 * Registers read-only OpenCode V2 hooks against a V2 plugin context.
 * The caller's Plugin.define wrapper owns the actual OpenCode dependency.
 */
export async function setupOpenCodeV2Observer(ctx, options={}) {
  const directory=options.directory ?? process.cwd();
  const observer=new OpenCodeObserver({directory,traceFile:options.traceFile});

  await ctx.session.hook("prompt", (event) => { observer.onPrompt(event); });
  await ctx.session.hook("context", (event) => { observer.onContext(event); });
  await ctx.tool.hook("execute.before", (event) => { observer.onToolBefore(event); });
  await ctx.tool.hook("execute.after", (event) => { observer.onToolAfter(event); });

  if (ctx.event?.subscribe) {
    await ctx.event.subscribe((event) => {
      const type=event?.type ?? event?.event;
      if (type === "session.created") observer.onSessionCreated(event);
      else if (type === "session.idle") observer.onSessionIdle(event);
      else if (type === "session.error") observer.onSessionError(event);
      else if (type === "file.edited") observer.onFileEdited(event);
    });
  }
  return observer;
}

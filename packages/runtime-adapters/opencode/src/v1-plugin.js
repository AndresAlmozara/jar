import { OpenCodeObserver } from "./observer.js";

/**
 * Legacy/current ECC-style OpenCode bridge. Read-only: it only observes.
 * This mirrors the hook surface used by ECC's current .opencode plugin.
 */
export async function JarObserverPlugin(input={}) {
  const directory=input.worktree || input.directory || process.cwd();
  const observer=new OpenCodeObserver({directory});
  return {
    "session.created": async (event) => observer.onSessionCreated(event),
    "chat.message": async (event) => observer.onPrompt(event),
    "file.edited": async (event) => observer.onFileEdited(event),
    "tool.execute.before": async (inputEvent) => observer.onToolBefore(inputEvent),
    "tool.execute.after": async (inputEvent, output) => observer.onToolAfter({...inputEvent,output}),
    "session.error": async (event) => observer.onSessionError(event),
    "session.idle": async (event) => observer.onSessionIdle(event),
  };
}

export default JarObserverPlugin;

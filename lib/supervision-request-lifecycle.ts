export type SupervisionSessionIdentity = {
  sessionId: string;
  sessionToken: string | null;
};

export type SupervisionRequestSnapshot = SupervisionSessionIdentity & {
  lifecycleVersion: number;
  requestSequence: number;
};

export class SupervisionRequestLifecycle {
  private lifecycleVersion = 0;
  private requestSequence = 0;
  private activeSession: SupervisionSessionIdentity | null = null;

  activate(session: SupervisionSessionIdentity) {
    this.lifecycleVersion += 1;
    this.activeSession = { ...session };
  }

  invalidate() {
    this.lifecycleVersion += 1;
    this.activeSession = null;
  }

  begin(session: SupervisionSessionIdentity): SupervisionRequestSnapshot {
    this.requestSequence += 1;
    return {
      ...session,
      lifecycleVersion: this.lifecycleVersion,
      requestSequence: this.requestSequence
    };
  }

  isCurrent(snapshot: SupervisionRequestSnapshot) {
    return (
      snapshot.lifecycleVersion === this.lifecycleVersion &&
      snapshot.requestSequence === this.requestSequence &&
      this.activeSession?.sessionId === snapshot.sessionId &&
      this.activeSession?.sessionToken === snapshot.sessionToken
    );
  }
}

export function replaceAbortController(previous: AbortController | null) {
  previous?.abort();
  return new AbortController();
}

export function isAbortError(error: unknown) {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError")
  );
}

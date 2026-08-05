import type { TaskboardSubmission } from "./taskboard-channel-command.js";

type ProcessedSubmission = {
  readonly createdAt: number;
  readonly projectId: string;
  readonly operation: TaskboardSubmission["operation"];
  readonly identifier?: string;
};

export class TaskboardSubmissionDeduplicator {
  private readonly processed = new Map<string, ProcessedSubmission>();

  lookup(
    requestId: string | undefined,
    projectId: string,
    submission: TaskboardSubmission
  ): "new" | "duplicate" | "mismatch" {
    this.prune();
    if (!requestId) return "new";
    const existing = this.processed.get(requestId);
    if (!existing) return "new";
    return sameSubmission(existing, projectId, submission) ? "duplicate" : "mismatch";
  }

  record(requestId: string | undefined, projectId: string, submission: TaskboardSubmission): void {
    if (!requestId) return;
    this.processed.set(requestId, {
      createdAt: Date.now(),
      projectId,
      operation: submission.operation,
      ...(submission.operation === "create_todo" || submission.operation === "create_start"
        ? {}
        : { identifier: submission.identifier })
    });
  }

  delete(requestId: string | undefined): void {
    if (requestId) this.processed.delete(requestId);
  }

  private prune(): void {
    const cutoff = Date.now() - 30 * 60 * 1_000;
    for (const [key, submission] of this.processed) {
      if (submission.createdAt < cutoff) this.processed.delete(key);
    }
  }
}

function sameSubmission(
  existing: ProcessedSubmission,
  projectId: string,
  submission: TaskboardSubmission
): boolean {
  return existing.projectId === projectId
    && existing.operation === submission.operation
    && existing.identifier === (
      submission.operation === "create_todo" || submission.operation === "create_start"
        ? undefined
        : submission.identifier
    );
}

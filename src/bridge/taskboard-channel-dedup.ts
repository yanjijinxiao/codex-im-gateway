import type { TaskboardSubmission } from "./taskboard-channel-command.js";

type ProcessedSubmission = {
  readonly createdAt: number;
  readonly projectId: string;
  readonly operation: TaskboardSubmission["operation"];
  readonly identifier?: string;
  readonly completion: SubmissionCompletion;
  completedAt?: number;
};

export type TaskboardSubmissionReservation =
  | { readonly kind: "owner"; readonly finish: (success: boolean) => void }
  | { readonly kind: "duplicate"; readonly completion: Promise<boolean> }
  | { readonly kind: "mismatch" };

export class TaskboardSubmissionDeduplicator {
  private readonly processed = new Map<string, ProcessedSubmission>();

  reserve(
    requestId: string | undefined,
    projectId: string,
    submission: TaskboardSubmission
  ): TaskboardSubmissionReservation {
    this.prune();
    if (!requestId) return { kind: "owner", finish() {} };
    const existing = this.processed.get(requestId);
    if (existing) {
      return sameSubmission(existing, projectId, submission)
        ? { kind: "duplicate", completion: existing.completion.promise }
        : { kind: "mismatch" };
    }
    const entry: ProcessedSubmission = {
      createdAt: Date.now(),
      projectId,
      operation: submission.operation,
      completion: new SubmissionCompletion(),
      ...(submission.operation === "create_todo" || submission.operation === "create_start"
        ? {}
        : { identifier: submission.identifier })
    };
    this.processed.set(requestId, entry);
    return {
      kind: "owner",
      finish: (success) => {
        if (this.processed.get(requestId) !== entry) return;
        entry.completion.resolve(success);
        if (success) entry.completedAt = Date.now();
        else this.processed.delete(requestId);
      }
    };
  }

  private prune(): void {
    const cutoff = Date.now() - 30 * 60 * 1_000;
    for (const [key, submission] of this.processed) {
      if (submission.completedAt !== undefined && submission.completedAt < cutoff) {
        this.processed.delete(key);
      }
    }
  }
}

class SubmissionCompletion {
  private resolver?: (success: boolean) => void;
  readonly promise = new Promise<boolean>((resolve) => {
    this.resolver = resolve;
  });

  resolve(success: boolean): void {
    const resolver = this.resolver;
    if (!resolver) return;
    this.resolver = undefined;
    resolver(success);
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

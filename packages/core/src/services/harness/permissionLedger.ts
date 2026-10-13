import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { AgentEvent, PlannerAsk } from './AgentAdapter';

type OnEvent = (event: AgentEvent) => void;

/**
 * A runner's permission request, read by its adapter into the shape every
 * runner shares (ADR-0026). What the ledger does with it depends only on this
 * and the adapter's stance, never on which runner asked.
 */
export interface RaisedRequest {
  id: string;
  name: string;
  detail: string;
  input?: Record<string, unknown>;
  /** The runner's own session-scoped grants. Shown on a task's request only: a planner's grants are the session policy's. */
  suggestions?: unknown[];
  toolUseId?: string;
  /** What the request is for, in the envelope's terms. Shown on a planner's request only. */
  ask?: PlannerAsk;
  /** One of the Ordewell server's own tools, told apart by exact name (ADR-0022, S3). */
  ordewell: boolean;
}

export interface LedgerStance {
  role: 'planner' | 'task';
  /** A task whose mode's manifest sets `approvals: auto`, answered as the runner's own auto mode would (ADR-0001). */
  autoApprove: boolean;
}

const ALLOW: ApprovalDecision = { decision: 'allow' };

/**
 * Every permission request a runner raises, from the moment it is read to its
 * answer: whether it is allowed at once or held open, the answer through the
 * runner's own reply, and the event each step shows. An adapter supplies only
 * how to read its runner's request and how to `reply` to it.
 */
export class PermissionLedger<Handle> {
  private readonly open = new Map<string, Handle>();

  constructor(
    /** Sends the answer in the runner's own schema. Must not throw: a runner that forgot the request will not hang on it. */
    private readonly reply: (handle: Handle, decision: ApprovalDecision) => void,
    /** Read at each request, since a ledger is made before its runner starts. */
    private readonly stance: () => LedgerStance,
  ) {}

  /**
   * An Ordewell tool is allowed whatever the mode — a completion that waited on
   * a person would hold the verdict hostage (ADR-0022, S3) — as is a task's
   * request under an auto-approving mode, announced already decided so the log
   * still shows it. Anything else is held: a task's for a person (ADR-0018,
   * A1), a planner's for its envelope (ADR-0026).
   */
  raise(request: RaisedRequest, handle: Handle, onEvent: OnEvent): void {
    const { ordewell, suggestions, ask, ...shown } = request;
    const { role, autoApprove } = this.stance();
    if (ordewell || (role === 'task' && autoApprove)) {
      // Answered even when showing it throws: that is Ordewell's failure, and a
      // runner left waiting on its completion call would hang the task.
      try {
        onEvent({ type: 'permission_request', ...shown, decided: ALLOW });
      } finally {
        this.reply(handle, ALLOW);
      }
      return;
    }
    this.open.set(request.id, handle);
    onEvent(role === 'task'
      ? { type: 'permission_request', ...shown, suggestions: suggestions ?? [] }
      : { type: 'permission_request', ...shown, ...(ask ? { ask } : {}) });
  }

  /** The answer to an open request. False when it is not open — answered, withdrawn, or never asked. */
  answer(id: string, decision: ApprovalDecision): boolean {
    if (!this.open.has(id)) return false;
    const handle = this.open.get(id) as Handle;
    this.open.delete(id);
    this.reply(handle, decision);
    return true;
  }

  /** The runner settled a request itself — an interrupt cancelled its call, or its own rule answered it. It takes no answer now. */
  withdraw(id: string | undefined, onEvent: OnEvent): void {
    if (id !== undefined && this.open.delete(id)) onEvent({ type: 'permission_cancelled', id });
  }

  /**
   * A runner asks only mid-turn and blocks on the answer, so a request still
   * open once the turn is over was dropped by whatever ended it, said so or not.
   */
  endTurn(onEvent: OnEvent): void {
    for (const id of [...this.open.keys()]) {
      this.open.delete(id);
      onEvent({ type: 'permission_cancelled', id });
    }
  }
}

import React from 'react';

interface PlannerLoginActionProps {
  onLogIn: () => void;
  pending?: boolean;
  /** The row's larger action or a pill's small one; both keep their slot while pending. */
  className: string;
  ariaLabel?: string;
  title?: string;
}

/**
 * The one login action the signed-out surface offers. The empty-state row and
 * a pill's own action draw the same words, spinner and busy state so a login
 * cannot look like two different controls depending on where it started.
 */
export default function PlannerLoginAction({ onLogIn, pending, className, ariaLabel, title }: PlannerLoginActionProps) {
  return (
    <button
      type="button"
      className={className}
      onClick={onLogIn}
      disabled={pending}
      aria-busy={pending ? true : undefined}
      aria-label={ariaLabel}
      title={title}
    >
      {pending
        ? <><span className="planner-login-spinner" aria-hidden="true" />Signing in…</>
        : 'Log in'}
    </button>
  );
}

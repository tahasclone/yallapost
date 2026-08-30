"use client";

import { useState } from "react";

import styles from "./agents.module.css";

export interface GateCall {
  toolCallId: string;
  toolName: string;
  platform: string;
  caption: string;
  videoSrc?: string;
  rawArguments: string;
}

export interface ApprovalGateProps {
  calls: GateCall[];
  busy: boolean;
  onApprove: () => void;
  onReject: (reason: string) => void;
}

/**
 * The one place in the product where the harness stops and waits for a human.
 * Deliberately heavy: this is the irreversible action, and the operator sees
 * exactly what will run before choosing.
 *
 * Every pending call renders here, because the decision below applies to the
 * whole batch: the harness requires all pending calls resolved together, and
 * approving actions that were never displayed is not approval.
 */
export function ApprovalGate({ calls, busy, onApprove, onReject }: ApprovalGateProps) {
  const [reason, setReason] = useState("");
  return (
    <section className={styles.gate} aria-labelledby="gate-heading" aria-live="assertive">
      <header className={styles.gateHeader}>
        <span className={styles.gateBadge}>⚠ HUMAN APPROVAL REQUIRED</span>
        <h2 id="gate-heading">This publishes publicly and cannot be undone.</h2>
        <p>
          {calls.length === 1
            ? `The agent wants to run ${calls[0]?.toolName ?? "a tool"}.`
            : `The agent wants to run ${calls.length} gated tool calls. Your decision below applies to all of them; review each one.`}{" "}
          Nothing goes live until you decide.
        </p>
      </header>

      {calls.map((call, i) => (
        <div key={call.toolCallId} className={styles.gateBody} style={{ borderTop: i > 0 ? "2px dashed rgba(176,48,48,0.5)" : undefined, paddingTop: i > 0 ? 14 : 0 }}>
          <div className={styles.gateCaption}>
            <strong>
              {i + 1}/{calls.length} · <code>{call.toolName}</code>
              {call.platform ? <> → <em>{call.platform}</em></> : null}
            </strong>
            <p>{call.caption || "(no caption in arguments)"}</p>
            <details className={styles.gateArgs}>
              <summary>Exact tool arguments</summary>
              <pre>{call.rawArguments}</pre>
            </details>
          </div>
          {call.videoSrc ? (
            <video className={styles.gateVideo} src={call.videoSrc} controls preload="metadata" />
          ) : null}
        </div>
      ))}

      <div className={styles.gateActions}>
        <button className={styles.approveButton} disabled={busy} onClick={onApprove}>
          Approve {calls.length === 1 ? "— publish it" : `all ${calls.length} — publish`}
        </button>
        <div className={styles.rejectRow}>
          <input
            type="text"
            placeholder="What should change? (sent to the agent)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Rejection reason"
          />
          <button
            className={styles.rejectButton}
            disabled={busy}
            onClick={() => onReject(reason.trim() || "Rejected by the operator; revise and try again.")}
          >
            Reject {calls.length === 1 ? "— send back" : "all — send back"}
          </button>
        </div>
      </div>
    </section>
  );
}

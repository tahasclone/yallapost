"use client";

import { useState } from "react";

import styles from "./agents.module.css";

export interface ApprovalGateProps {
  toolName: string;
  platform: string;
  caption: string;
  videoSrc?: string;
  rawArguments: string;
  busy: boolean;
  onApprove: () => void;
  onReject: (reason: string) => void;
}

/**
 * The one place in the product where the harness stops and waits for a human.
 * Deliberately heavy: this is the irreversible action, and the operator sees
 * exactly what will run before choosing.
 */
export function ApprovalGate({
  toolName,
  platform,
  caption,
  videoSrc,
  rawArguments,
  busy,
  onApprove,
  onReject,
}: ApprovalGateProps) {
  const [reason, setReason] = useState("");
  return (
    <section className={styles.gate} aria-labelledby="gate-heading" aria-live="assertive">
      <header className={styles.gateHeader}>
        <span className={styles.gateBadge}>⚠ HUMAN APPROVAL REQUIRED</span>
        <h2 id="gate-heading">This publishes publicly and cannot be undone.</h2>
        <p>
          The agent wants to run <code>{toolName}</code> and post to{" "}
          <strong>{platform || "?"}</strong>. Nothing goes live until you decide.
        </p>
      </header>

      <div className={styles.gateBody}>
        <div className={styles.gateCaption}>
          <strong>Caption as it will appear</strong>
          <p>{caption || "(no caption in arguments)"}</p>
        </div>
        {videoSrc ? (
          <video className={styles.gateVideo} src={videoSrc} controls preload="metadata" />
        ) : null}
      </div>

      <details className={styles.gateArgs}>
        <summary>Exact tool arguments</summary>
        <pre>{rawArguments}</pre>
      </details>

      <div className={styles.gateActions}>
        <button className={styles.approveButton} disabled={busy} onClick={onApprove}>
          Approve — publish it
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
            onClick={() => onReject(reason.trim() || "Rejected by the operator; revise the caption.")}
          >
            Reject — send back
          </button>
        </div>
      </div>
    </section>
  );
}

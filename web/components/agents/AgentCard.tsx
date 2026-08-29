import Image from "next/image";

import redRobot from "./assets/red-robot.png";
import blueRobot from "./assets/blue-robot.png";
import styles from "./agents.module.css";

export type AgentState = "idle" | "working" | "blocked" | "done";
export type TaskStatus = "pending" | "active" | "done";

export interface AgentTask {
  id: string;
  label: string;
  status: TaskStatus;
  etaSeconds?: number;
}

export interface Subagent {
  source: string;
  status: TaskStatus;
  itemCount?: number;
}

export interface AgentCardProps {
  name: string;
  role: string;
  state: AgentState;
  tasks: AgentTask[];
  blockedOn?: string;
  subagents?: Subagent[];
}

const stateLabels: Record<AgentState, string> = {
  idle: "Standing by",
  working: "In motion",
  blocked: "Needs you",
  done: "Finished",
};

const taskStatusLabels: Record<TaskStatus, string> = {
  pending: "Pending",
  active: "Active",
  done: "Completed",
};

const robotByAgent = {
  Scout: redRobot,
  Producer: blueRobot,
  Editor: blueRobot,
  Publisher: redRobot,
};

function formatEta(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

function StatusMark({ status }: { status: TaskStatus }) {
  return (
    <span className={`${styles.statusMark} ${styles[`statusMark_${status}`]}`} aria-hidden="true">
      {status === "done" ? "✓" : status === "active" ? "→" : "○"}
    </span>
  );
}

export function AgentCard({
  name,
  role,
  state,
  tasks,
  blockedOn,
  subagents,
}: AgentCardProps) {
  const robot = robotByAgent[name as keyof typeof robotByAgent] ?? redRobot;

  return (
    <article className={`${styles.agentCard} ${styles[`agentCard_${state}`]}`}>
      <div className={styles.agentHeader}>
        <div>
          <p className={styles.agentRole}>{role}</p>
          <h2 className={styles.agentName}>{name}</h2>
        </div>
        <span className={`${styles.stateBadge} ${styles[`stateBadge_${state}`]}`}>
          <span aria-hidden="true" className={styles.stateSignal} />
          {stateLabels[state]}
        </span>
      </div>

      <div className={styles.agentBody}>
        <div className={`${styles.figureStage} ${styles[`figureStage_${state}`]}`}>
          <span className={styles.figureShadow} aria-hidden="true" />
          <div className={`${styles.figure} ${styles[`figure_${name.toLowerCase()}`]}`}>
            <Image
              src={robot}
              alt={`${name}, the ${role.toLowerCase()} agent`}
              fill
              sizes="(max-width: 720px) 42vw, 190px"
              className={styles.figureImage}
              priority={name === "Scout"}
            />
          </div>
          <span className={styles.figureCaption}>AGENT // {name.toUpperCase()}</span>
        </div>

        <section className={styles.whiteboard} aria-label={`${name} task board`}>
          <span className={styles.boardTape} aria-hidden="true" />
          <div className={styles.boardHeading}>
            <span>Today&apos;s work</span>
            <span className={styles.boardCount}>{tasks.filter((task) => task.status === "done").length}/{tasks.length}</span>
          </div>
          <ol className={styles.taskList}>
            {tasks.map((task) => (
              <li
                key={task.id}
                className={`${styles.taskRow} ${styles[`taskRow_${task.status}`]}`}
              >
                <StatusMark status={task.status} />
                <span className={styles.srOnly}>Status: {taskStatusLabels[task.status]}.</span>
                <span className={styles.taskLabel}>{task.label}</span>
                {task.etaSeconds !== undefined && task.status !== "done" ? (
                  <span className={styles.eta}>~{formatEta(task.etaSeconds)}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      </div>

      {state === "blocked" ? (
        <aside className={styles.blockedPanel}>
          <span className={styles.blockedStamp}>STOPPED</span>
          <div>
            <strong>Waiting for your approval</strong>
            <p>{blockedOn ?? "A decision is required before this agent can continue."}</p>
          </div>
          <span className={styles.blockedArrow} aria-hidden="true">↗</span>
        </aside>
      ) : null}

      {subagents?.length ? (
        <section className={styles.subagentPanel} aria-label={`${name} source agents`}>
          <div className={styles.subagentHeading}>
            <strong>Source runners</strong>
            <span>{subagents.filter((agent) => agent.status === "done").length} resolved</span>
          </div>
          <div className={styles.subagentGrid}>
            {subagents.map((subagent) => (
              <div className={`${styles.subagentRow} ${styles[`subagentRow_${subagent.status}`]}`} key={subagent.source}>
                <StatusMark status={subagent.status} />
                <span className={styles.srOnly}>Status: {taskStatusLabels[subagent.status]}.</span>
                <span>{subagent.source}</span>
                <span className={styles.subagentResult}>
                  {subagent.status === "active" ? "scanning" : subagent.status === "pending" ? "queued" : `${subagent.itemCount ?? 0} hits`}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}

"use client";

import styles from "./agents.module.css";

export interface EdlTimelineClip {
  beat_id: string;
  source_start: number;
  source_end: number;
  image_url?: string;
}

export interface EdlTimelineProps {
  clips: EdlTimelineClip[];
  captionCount: number;
  sourceVideo: string;
}

/**
 * The agent's editing decisions made visible: each block is one cut from the
 * source clip, in output order, sized by duration.
 */
export function EdlTimeline({ clips, captionCount, sourceVideo }: EdlTimelineProps) {
  const total = clips.reduce((sum, c) => sum + (c.source_end - c.source_start), 0);
  return (
    <section className={styles.panel} aria-labelledby="edl-heading">
      <header className={styles.panelHeader}>
        <p className={styles.sectionKicker}>Editor decided</p>
        <h2 id="edl-heading">The cut, before it renders</h2>
        <p>
          {clips.length} cuts from <code>{sourceVideo}</code>, {total.toFixed(1)}s total,{" "}
          {captionCount} captions burned in.
        </p>
      </header>
      <div className={styles.timeline} role="list">
        {clips.map((clip, i) => {
          const duration = clip.source_end - clip.source_start;
          return (
            <div
              key={`${clip.beat_id}-${i}`}
              role="listitem"
              className={styles.timelineClip}
              style={{ flexGrow: Math.max(duration, 0.5) }}
            >
              <span className={styles.timelineBeat}>{clip.beat_id}</span>
              <span className={styles.timelineRange}>
                {clip.source_start.toFixed(1)}s → {clip.source_end.toFixed(1)}s
              </span>
              <span className={styles.timelineBadges}>
                {clip.image_url ? "🖼 overlay" : "— no overlay"}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

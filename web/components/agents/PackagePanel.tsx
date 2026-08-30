"use client";

import styles from "./agents.module.css";

export interface Beat {
  id: string;
  text: string;
  visual_cue: string;
  image_url?: string;
}

export interface PackagePanelProps {
  title: string;
  beats: Beat[];
  onBeatTextChange: (beatId: string, text: string) => void;
  imagesNote?: string;
}

/** The produced script and images, editable inline before the edit stage. */
export function PackagePanel({ title, beats, onBeatTextChange, imagesNote }: PackagePanelProps) {
  return (
    <section className={styles.panel} aria-labelledby="package-heading">
      <header className={styles.panelHeader}>
        <p className={styles.sectionKicker}>Producer delivered</p>
        <h2 id="package-heading">{title}</h2>
        <p>Edit any beat before you record. What you see here is what the Editor will cut to.</p>
        {imagesNote ? <p className={styles.panelNote}>{imagesNote}</p> : null}
      </header>
      <ol className={styles.beatList}>
        {beats.map((beat, i) => (
          <li key={beat.id} className={styles.beatItem}>
            <div className={styles.beatMeta}>
              <span className={styles.beatNumber}>Beat {i + 1}</span>
              <span className={styles.beatCue}>🎬 {beat.visual_cue}</span>
            </div>
            <textarea
              className={styles.beatText}
              value={beat.text}
              rows={2}
              onChange={(e) => onBeatTextChange(beat.id, e.target.value)}
              aria-label={`Beat ${i + 1} script text`}
            />
            {beat.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- remote generated images, unknown dimensions
              <img className={styles.beatImage} src={beat.image_url} alt={beat.visual_cue} />
            ) : (
              <p className={styles.beatNoImage}>no image for this beat</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

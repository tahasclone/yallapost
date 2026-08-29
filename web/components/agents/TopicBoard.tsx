import styles from "./agents.module.css";

export interface TopicEvidence {
  source: string;
  relativeTime: string;
  href: string;
}

export interface Topic {
  id: string;
  title: string;
  summary: string;
  velocity: string;
  evidence: TopicEvidence[];
}

export function TopicBoard({ topics }: { topics: Topic[] }) {
  return (
    <section className={styles.topicBoard} aria-labelledby="topics-heading">
      <header className={styles.topicBoardHeader}>
        <div>
          <p className={styles.sectionKicker}>Scout found a signal</p>
          <h2 id="topics-heading">Three stories worth making today.</h2>
          <p>Each one is backed by live source evidence. Pick a direction and Producer will take it from there.</p>
        </div>
        <div className={styles.boardNote} aria-label="Topic selection status">
          <span>YOUR MOVE</span>
          Choose one topic
          <i aria-hidden="true">↙</i>
        </div>
      </header>

      <div className={styles.topicGrid}>
        {topics.map((topic, index) => (
          <article className={styles.topicCard} key={topic.id}>
            <div className={styles.topicTopline}>
              <span className={styles.topicNumber}>0{index + 1}</span>
              <span className={styles.velocity}>↗ {topic.velocity}</span>
            </div>
            <h3>{topic.title}</h3>
            <p className={styles.topicSummary}>{topic.summary}</p>

            <div className={styles.evidenceBlock}>
              <strong>Evidence</strong>
              <ul>
                {topic.evidence.map((item) => (
                  <li key={`${topic.id}-${item.source}`}>
                    <a href={item.href} target="_blank" rel="noreferrer">
                      <span>{item.source}</span>
                      <small>{item.relativeTime} ↗</small>
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            <button type="button" className={styles.selectButton}>
              Select this topic
              <span aria-hidden="true">→</span>
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

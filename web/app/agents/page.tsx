import { Caveat } from "next/font/google";

import { AgentCard, TopicBoard, type AgentCardProps, type Topic } from "@/components/agents";
import styles from "@/components/agents/agents.module.css";

const caveat = Caveat({ subsets: ["latin"], variable: "--font-hand", display: "swap" });

const agents: AgentCardProps[] = [
  {
    name: "Scout",
    role: "Signal researcher",
    state: "working",
    tasks: [
      { id: "watchlist", label: "Sweep the watchlist", status: "done" },
      { id: "cluster", label: "Cluster repeated signals", status: "active", etaSeconds: 44 },
      { id: "velocity", label: "Score topic velocity", status: "pending", etaSeconds: 95 },
    ],
    subagents: [
      { source: "YC founders on X", status: "done", itemCount: 18 },
      { source: "Startup Instagram", status: "active", itemCount: 7 },
      { source: "a16z feeds", status: "done", itemCount: 12 },
      { source: "Pre-seed keywords", status: "pending" },
    ],
  },
  {
    name: "Producer",
    role: "Script and image maker",
    state: "done",
    tasks: [
      { id: "angle", label: "Lock the creator angle", status: "done" },
      { id: "script", label: "Write the 45-second script", status: "done" },
      { id: "images", label: "Generate matching frames", status: "done" },
    ],
  },
  {
    name: "Editor",
    role: "Video assembly",
    state: "idle",
    tasks: [
      { id: "upload", label: "Receive phone recording", status: "pending" },
      { id: "transcribe", label: "Align speech to script beats", status: "pending", etaSeconds: 120 },
      { id: "render", label: "Render the final cut", status: "pending", etaSeconds: 180 },
    ],
  },
  {
    name: "Publisher",
    role: "Caption and release",
    state: "blocked",
    blockedOn: "The caption is drafted. Publishing is irreversible, so nothing goes live until you approve it.",
    tasks: [
      { id: "caption", label: "Draft platform caption", status: "done" },
      { id: "approval", label: "Get human approval", status: "active" },
      { id: "publish", label: "Publish the approved post", status: "pending" },
    ],
  },
];

const topics: Topic[] = [
  {
    id: "founder-mode",
    title: "Founder-led distribution is moving in-house",
    summary: "Early teams are replacing polished brand accounts with direct, frequent posts from founders.",
    velocity: "+38% in 6h",
    evidence: [
      { source: "@ycombinator", relativeTime: "18m ago", href: "https://x.com/ycombinator" },
      { source: "a16z Future", relativeTime: "1h ago", href: "https://a16z.com" },
      { source: "@garrytan", relativeTime: "2h ago", href: "https://x.com/garrytan" },
    ],
  },
  {
    id: "tiny-models",
    title: "Tiny models are becoming the product moat",
    summary: "Founders are showing where small, specialized models beat larger general systems on cost and speed.",
    velocity: "+27% in 4h",
    evidence: [
      { source: "Hacker News", relativeTime: "24m ago", href: "https://news.ycombinator.com" },
      { source: "@swyx", relativeTime: "47m ago", href: "https://x.com/swyx" },
      { source: "Latent Space", relativeTime: "3h ago", href: "https://www.latent.space" },
    ],
  },
  {
    id: "preseed-proof",
    title: "Pre-seed investors want proof before polish",
    summary: "More investors are asking for scrappy usage evidence instead of a perfect deck and distant roadmap.",
    velocity: "+19% in 8h",
    evidence: [
      { source: "@nikitabier", relativeTime: "32m ago", href: "https://x.com/nikitabier" },
      { source: "NFX Essays", relativeTime: "2h ago", href: "https://www.nfx.com/post" },
      { source: "First Round", relativeTime: "5h ago", href: "https://review.firstround.com" },
    ],
  },
];

export default function AgentsDemoPage() {
  return (
    <main className={`${styles.page} ${caveat.variable}`}>
      <div className={styles.pageShell}>
        <header className={styles.masthead}>
          <div>
            <div className={styles.brandRow}>
              <span className={styles.brandMark}>Y</span>
              <span className={styles.brandName}>YallaPost</span>
              <span className={styles.cycleLabel}>DAILY CONTENT CREW</span>
            </div>
            <h1>Your agents did the homework. <span>You make the call.</span></h1>
          </div>
          <aside className={styles.mastheadAside}>
            <p>See what is moving, what is finished, and exactly where your decision is required.</p>
            <div className={styles.pipelineKey} aria-label="Agent pipeline">
              <span>Scout</span><span>Producer</span><span>Editor</span><span>Publisher</span>
            </div>
          </aside>
        </header>

        <section className={styles.agentSection} aria-labelledby="crew-heading">
          <div className={styles.sectionLead}>
            <h2 id="crew-heading">The crew, right now</h2>
            <span>Mock cycle preview</span>
          </div>
          <div className={styles.agentGrid}>
            {agents.map((agent) => <AgentCard key={agent.name} {...agent} />)}
          </div>
        </section>

        <TopicBoard topics={topics} />

        <footer className={styles.footerNote}>
          <span><strong>YallaPost</strong> decides what is worth making today.</span>
          <span>Nothing publishes without a human yes.</span>
        </footer>
      </div>
    </main>
  );
}

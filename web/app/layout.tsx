import type { ReactNode } from "react";

export const metadata = {
  title: "Daily Content Agent",
  description: "Drives TrueForge and renders its event stream",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          margin: 0,
          padding: 16,
          background: "#111",
          color: "#eee",
        }}
      >
        {children}
      </body>
    </html>
  );
}

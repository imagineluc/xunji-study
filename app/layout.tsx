import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "循记日历 · 任务与记忆复习",
    description: "把日常任务与艾宾浩斯复习安排放进同一张清晰、安静的日历。",
    manifest: "/manifest.webmanifest",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "循记日历 · 任务与记忆复习",
      description: "一张日历，安排任务，也照顾记忆节奏。",
      type: "website",
      images: [{ url: image, width: 1536, height: 1024, alt: "循记日历" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "循记日历 · 任务与记忆复习",
      description: "一张日历，安排任务，也照顾记忆节奏。",
      images: [image],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}

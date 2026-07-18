import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.includes("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "循记 · 艾宾浩斯学习助手",
    description: "任务、复习日历、专注与学习统计，在一个清晰的学习工作台中保持同步。",
    manifest: "/manifest.webmanifest",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "循记 · 艾宾浩斯学习助手",
      description: "把要记住的事，交给节奏和重复。",
      type: "website",
      images: [{ url: image, width: 1536, height: 1024, alt: "循记学习助手" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "循记 · 艾宾浩斯学习助手",
      description: "把要记住的事，交给节奏和重复。",
      images: [image],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}

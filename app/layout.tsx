import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Last Studio — 신발 형상 작업실",
  description: "다측면 이미지와 3D 라스트를 한 공간에서 정렬하고, 비교하고, 공유하는 신발 형상 작업실입니다.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}

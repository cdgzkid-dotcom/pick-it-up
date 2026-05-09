import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import './globals.css';

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'PICK IT UP',
  description: 'Personal sports betting AI',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'PICK IT UP' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#08080d',
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={mono.variable}>
      <body className="font-mono bg-bg text-fg min-h-screen">{children}</body>
    </html>
  );
}

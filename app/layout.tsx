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
  viewportFit: 'cover',
};

const themeBootstrap = `(function(){try{var h=new Date().getHours();if(h>=6&&h<19){document.documentElement.classList.add('light');}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={mono.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: light)"
          content="#f5f5f5"
        />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: dark)"
          content="#08080d"
        />
      </head>
      <body className="font-mono bg-bg text-fg min-h-screen">{children}</body>
    </html>
  );
}

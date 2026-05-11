import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono } from 'next/font/google';
import './globals.css';
import ThemeWatcher from '@/components/ThemeWatcher';

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

const themeBootstrap = `(function(){try{
  var now=Date.now();var isLight;
  var raw=localStorage.getItem('pick-it-up:sun');
  if(raw){
    var c=JSON.parse(raw);
    if(c&&c.sunrise&&c.sunset&&c.fetched_at&&(now-c.fetched_at)<86400000){
      var sr=new Date(c.sunrise).getTime();
      var ss=new Date(c.sunset).getTime();
      isLight=now>=sr&&now<ss;
    }
  }
  if(isLight===undefined){
    var cdmx=new Date(now-21600000);
    var h=cdmx.getUTCHours()+cdmx.getUTCMinutes()/60;
    isLight=h>=6.75&&h<19.25;
  }
  document.documentElement.classList.toggle('light',isLight);
}catch(e){}})();`;

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
      <body className="font-mono bg-bg text-fg min-h-screen">
        <ThemeWatcher />
        {children}
      </body>
    </html>
  );
}

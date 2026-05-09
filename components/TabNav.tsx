'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const tabs = [
  { href: '/home', label: 'HOME', icon: '🏠' },
  { href: '/picks', label: 'PICKS', icon: '🎯' },
  { href: '/tracker', label: 'TRACKER', icon: '📊' },
  { href: '/stats', label: 'STATS', icon: '📈' },
];

export default function TabNav() {
  const pathname = usePathname();
  return (
    <nav className="fixed bottom-0 left-0 right-0 border-t border-line bg-bg/95 backdrop-blur z-50">
      <div className="max-w-xl mx-auto grid grid-cols-4">
        {tabs.map((t) => {
          const active = pathname?.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`tap flex flex-col items-center justify-center py-3 text-[10px] tracking-wider ${
                active ? 'text-green' : 'text-muted'
              }`}
            >
              <span className="text-lg leading-none mb-1">{t.icon}</span>
              <span>{t.label}</span>
            </Link>
          );
        })}
      </div>
      <div className="h-[env(safe-area-inset-bottom)] bg-bg" />
    </nav>
  );
}

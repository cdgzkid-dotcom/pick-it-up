import TabNav from '@/components/TabNav';

export default function TabsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen pb-20">
      <main className="max-w-xl mx-auto px-4 pt-4 pb-4">{children}</main>
      <TabNav />
    </div>
  );
}

import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/Sidebar';
import { ToastProvider } from '@/components/Toast';

export const metadata: Metadata = {
  title: 'MD Keno Predictor',
  description: 'Maryland Keno prediction engine — draw analysis, picks, and live session tracking',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-bg text-slate-200 min-h-screen">
        <ToastProvider>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex-1 min-w-0 p-4 md:p-6 md:pl-8">
              {children}
            </main>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}

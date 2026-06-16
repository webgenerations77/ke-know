import type { Metadata } from 'next';
import Image from 'next/image';
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
            <main className="flex-1 min-w-0 flex flex-col">
              <header className="flex justify-end items-center px-4 md:px-8 py-2 border-b border-[#1e1e24]">
                <Image
                  src="/Logo-Keno.png"
                  alt="KE-KNOW"
                  width={200}
                  height={70}
                  style={{ height: '52px', width: 'auto', objectFit: 'contain' }}
                  priority
                />
              </header>
              <div className="flex-1 p-4 md:p-6 md:pl-8">
                {children}
              </div>
            </main>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}

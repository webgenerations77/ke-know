'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

interface ToastItem {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastCtx {
  toast: (message: string, type?: ToastItem['type']) => void;
}

const ToastContext = createContext<ToastCtx>({ toast: () => {} });
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const toast = useCallback((message: string, type: ToastItem['type'] = 'info') => {
    const id = ++counter.current;
    setItems(prev => [...prev, { id, message, type }]);
    setTimeout(() => setItems(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 no-print">
        {items.map(item => (
          <div
            key={item.id}
            className={`px-4 py-3 rounded-lg text-sm font-medium shadow-lg transition-all ${
              item.type === 'success'
                ? 'bg-green-700 text-green-100'
                : item.type === 'error'
                ? 'bg-red-800 text-red-100'
                : 'bg-[#16161a] border border-[#333] text-slate-200'
            }`}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { AuthGate } from "@/components/auth/AuthGate";
import { SidebarNav } from "@/components/layout/SidebarNav";

export function MainShell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    const onOpenMenu = () => {
      setMenuOpen(true);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("open-main-menu", onOpenMenu);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("open-main-menu", onOpenMenu);
    };
  }, []);

  return (
    <AuthGate>
      <div className="relative min-h-screen">
        {menuOpen ? (
          <div className="fixed inset-0 z-50">
            <button
              className="absolute inset-0 bg-black/45"
              onClick={() => setMenuOpen(false)}
              type="button"
              aria-label="메뉴 닫기"
            />
            <div className="relative h-full w-fit">
              <SidebarNav onNavigate={() => setMenuOpen(false)} className="h-full w-72 pt-10 shadow-2xl" />
              <button
                className="absolute right-3 top-3 inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-100"
                onClick={() => setMenuOpen(false)}
                type="button"
                aria-label="메뉴 닫기 버튼"
              >
                <X className="h-3.5 w-3.5" />
                닫기
              </button>
            </div>
          </div>
        ) : null}

        <main className="p-6">{children}</main>
      </div>
    </AuthGate>
  );
}

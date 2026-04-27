"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Route } from "next";
import type { LucideIcon } from "lucide-react";
import {
  Home,
  FolderOpen,
  Images,
  Pencil,
  Clock3,
  Search,
  List,
  SlidersHorizontal,
  Shield,
  GitBranch,
  LogOut,
  User,
  Files,
} from "lucide-react";
import { buildApiUrl } from "@/lib/api-client";
import { userRoleLabel } from "@/lib/labels";

type AuthUser = {
  id: string;
  username: string;
  role: "ADMIN" | "EDITOR" | "REVIEWER" | "VIEWER";
};

type BrandingLogo = {
  exists: boolean;
  image_url: string | null;
  filename: string | null;
};

const menus: Array<{ href: Route; label: string; icon: LucideIcon }> = [
  { href: "/dashboard", label: "대시보드", icon: Home },
  { href: "/archive", label: "아카이브", icon: FolderOpen },
  { href: "/media", label: "미디어 갤러리", icon: Images },
  { href: "/mind-map", label: "마인드맵", icon: GitBranch },
  { href: "/manual-post", label: "수동 게시", icon: Pencil },
  { href: "/timeline", label: "타임라인", icon: Clock3 },
  { href: "/search", label: "검색", icon: Search },
  { href: "/review-queue", label: "검토 큐", icon: List },
  { href: "/rules", label: "규칙", icon: SlidersHorizontal },
  { href: "/admin", label: "관리자", icon: Shield },
];

export function SidebarNav({
  onNavigate,
  className = "",
}: {
  onNavigate?: () => void;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [logo, setLogo] = useState<BrandingLogo | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadMe() {
      try {
        const res = await fetch(buildApiUrl("/auth/me"), { cache: "no-store", credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json()) as AuthUser;
        if (!cancelled) setUser(data);
      } catch {
        // ignore
      }
    }
    async function loadLogo() {
      try {
        const res = await fetch(buildApiUrl("/branding/logo"), { cache: "no-store", credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json()) as BrandingLogo;
        if (!cancelled) setLogo(data);
      } catch {
        // ignore
      }
    }
    void Promise.all([loadMe(), loadLogo()]);
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = async () => {
    await fetch(buildApiUrl("/auth/logout"), { method: "POST", credentials: "include" });
    router.replace("/login");
    router.refresh();
  };

  return (
    <aside className={`w-64 shrink-0 border-r border-stone-200 bg-panel p-4 ${className}`}>
      {logo?.exists && logo.image_url ? (
        <div className="mb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={buildApiUrl(logo.image_url)} alt={logo.filename || "홈페이지 로고"} className="h-20 w-full object-contain" />
        </div>
      ) : null}
      <div className="mb-4 rounded-lg border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-amber-50 p-3 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white text-accent shadow-sm">
            <Files className="h-4 w-4" />
          </span>
          <FolderOpen className="h-4 w-4 text-emerald-700" />
        </div>
        <div className="space-y-0.5">
          <p className="text-xs font-semibold tracking-wider text-stone-700">문서 아카이브</p>
          <p className="text-[11px] text-stone-500">운영 메뉴</p>
        </div>
      </div>
      <nav className="space-y-1">
        {menus.map((menu) => {
          const active = pathname.startsWith(menu.href);
          const Icon = menu.icon;
          return (
            <Link
              key={menu.href}
              href={menu.href}
              onClick={() => onNavigate?.()}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
                active ? "bg-accent text-white" : "text-stone-700 hover:bg-stone-100"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {menu.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-6 border-t border-stone-200 pt-3 text-xs text-stone-600">
        <p className="flex items-center gap-1">
          <User className="h-3.5 w-3.5" />
          {user ? `${user.username} (${userRoleLabel(user.role)})` : "로그인 사용자 확인 중..."}
        </p>
        <button className="mt-2 inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 hover:bg-stone-100" onClick={logout}>
          <LogOut className="h-3.5 w-3.5" />
          로그아웃
        </button>
      </div>
    </aside>
  );
}

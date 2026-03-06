"use client";

import { useState } from "react";
import { HardDrive, History, Image as ImageIcon, Users } from "lucide-react";
import { AdminBackupManager } from "@/components/admin/AdminBackupManager";
import { AdminBrandingManager } from "@/components/admin/AdminBrandingManager";
import { AdminLogViewer } from "@/components/admin/AdminLogViewer";
import { AdminUserManager } from "@/components/admin/AdminUserManager";

type AdminTab = "users" | "logs" | "backup" | "branding";

export function AdminWorkspace() {
  const [tab, setTab] = useState<AdminTab>("users");

  return (
    <section className="space-y-4">
      <div className="flex gap-2">
        <button
          className={`inline-flex items-center gap-1 rounded border px-3 py-1 text-sm ${tab === "users" ? "border-accent bg-accent text-white" : "border-stone-300 hover:bg-stone-50"}`}
          onClick={() => setTab("users")}
        >
          <Users className="h-4 w-4" />
          사용자 관리
        </button>
        <button
          className={`inline-flex items-center gap-1 rounded border px-3 py-1 text-sm ${tab === "logs" ? "border-accent bg-accent text-white" : "border-stone-300 hover:bg-stone-50"}`}
          onClick={() => setTab("logs")}
        >
          <History className="h-4 w-4" />
          운영/감사 로그
        </button>
        <button
          className={`inline-flex items-center gap-1 rounded border px-3 py-1 text-sm ${tab === "backup" ? "border-accent bg-accent text-white" : "border-stone-300 hover:bg-stone-50"}`}
          onClick={() => setTab("backup")}
        >
          <HardDrive className="h-4 w-4" />
          백업/복구
        </button>
        <button
          className={`inline-flex items-center gap-1 rounded border px-3 py-1 text-sm ${tab === "branding" ? "border-accent bg-accent text-white" : "border-stone-300 hover:bg-stone-50"}`}
          onClick={() => setTab("branding")}
        >
          <ImageIcon className="h-4 w-4" />
          브랜딩
        </button>
      </div>

      {tab === "users" ? <AdminUserManager /> : null}
      {tab === "logs" ? <AdminLogViewer /> : null}
      {tab === "backup" ? <AdminBackupManager /> : null}
      {tab === "branding" ? <AdminBrandingManager /> : null}
    </section>
  );
}

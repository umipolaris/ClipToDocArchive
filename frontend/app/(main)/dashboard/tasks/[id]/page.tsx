"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CalendarDays, MapPin, MessageSquare } from "lucide-react";
import { PageMenuHeading } from "@/components/layout/PageMenuHeading";
import { apiGet } from "@/lib/api-client";

type DashboardTaskItem = {
  id: string;
  category: string;
  title: string;
  scheduled_at: string;
  all_day: boolean;
  location: string | null;
  comment: string | null;
};

interface PageProps {
  params: { id: string };
}

function formatSchedule(task: DashboardTaskItem): string {
  const dt = new Date(task.scheduled_at);
  if (Number.isNaN(dt.getTime())) return "-";
  if (task.all_day) {
    return `${dt.toLocaleDateString("ko-KR")} (종일)`;
  }
  return dt.toLocaleString("ko-KR");
}

export default function DashboardTaskDetailPage({ params }: PageProps) {
  const [item, setItem] = useState<DashboardTaskItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const res = await apiGet<DashboardTaskItem>(`/dashboard/tasks/${params.id}`);
        if (!cancelled) setItem(res);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "일정 상세 조회 실패");
          setItem(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  return (
    <section className="space-y-4">
      <PageMenuHeading title="일정 상세" href={`/dashboard/tasks/${params.id}`} />

      {loading ? <p className="text-sm text-stone-600">일정 상세 로딩 중...</p> : null}
      {!loading && error ? <p className="text-sm text-red-700">조회 실패: {error}</p> : null}

      {!loading && !error && item ? (
        <article className="space-y-3 rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
          <div className="flex items-center gap-2">
            <span className="rounded border border-stone-300 bg-stone-50 px-2 py-0.5 text-xs font-semibold text-stone-700">
              {item.category}
            </span>
            {item.all_day ? (
              <span className="rounded border border-stone-300 bg-white px-2 py-0.5 text-xs text-stone-700">종일</span>
            ) : null}
          </div>

          <h2 className="text-xl font-semibold text-stone-900">{item.title}</h2>

          <p className="inline-flex items-center gap-1 text-sm text-stone-700">
            <CalendarDays className="h-4 w-4 text-stone-500" />
            일정: {formatSchedule(item)}
          </p>

          {item.location ? (
            <p className="inline-flex items-center gap-1 text-sm text-stone-700">
              <MapPin className="h-4 w-4 text-stone-500" />
              장소: {item.location}
            </p>
          ) : null}

          {item.comment ? (
            <p className="inline-flex items-center gap-1 text-sm text-stone-700">
              <MessageSquare className="h-4 w-4 text-stone-500" />
              {item.comment}
            </p>
          ) : null}

          <div className="pt-2">
            <Link href="/dashboard" className="inline-flex items-center rounded border border-stone-300 px-3 py-1.5 text-xs hover:bg-stone-50">
              대시보드로 돌아가기
            </Link>
          </div>
        </article>
      ) : null}
    </section>
  );
}

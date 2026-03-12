"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CalendarDays, MapPin, MessageSquare, Paperclip } from "lucide-react";
import { PageMenuHeading } from "@/components/layout/PageMenuHeading";
import { apiGet, buildApiUrl } from "@/lib/api-client";

type DashboardTaskItem = {
  id: string;
  category: string;
  title: string;
  scheduled_at: string;
  ended_at: string | null;
  all_day: boolean;
  location: string | null;
  comment: string | null;
  linked_file_name: string | null;
  linked_file_download_path: string | null;
};

interface PageProps {
  params: { id: string };
}

function formatSchedule(task: DashboardTaskItem): string {
  const startedAt = new Date(task.scheduled_at);
  if (Number.isNaN(startedAt.getTime())) return "-";
  if (task.all_day) {
    return `${startedAt.toLocaleDateString("ko-KR")} (종일)`;
  }
  if (task.ended_at) {
    const endedAt = new Date(task.ended_at);
    if (!Number.isNaN(endedAt.getTime()) && endedAt.getTime() > startedAt.getTime()) {
      return `${startedAt.toLocaleString("ko-KR")} ~ ${endedAt.toLocaleString("ko-KR")}`;
    }
  }
  return startedAt.toLocaleString("ko-KR");
}

export default function DashboardTaskDetailPage({ params }: PageProps) {
  const router = useRouter();
  const [item, setItem] = useState<DashboardTaskItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState("");

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

  const deleteTask = async () => {
    if (!item || deleting) return;
    const confirmed = window.confirm(`'${item.title}' 일정을 삭제할까요?`);
    if (!confirmed) return;

    setDeleting(true);
    setActionError("");
    try {
      const res = await fetch(buildApiUrl(`/dashboard/tasks/${item.id}`), {
        method: "DELETE",
        cache: "no-store",
        credentials: "include",
      });
      if (!res.ok) {
        let message = `API error: ${res.status}`;
        try {
          const raw = await res.text();
          if (raw) {
            const parsed = JSON.parse(raw) as { detail?: unknown };
            const detail = typeof parsed.detail === "string" ? parsed.detail : raw;
            message = `API error: ${res.status} ${detail}`.trim();
          }
        } catch {
          // ignore parse error and fallback to status code
        }
        throw new Error(message);
      }
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "일정 삭제 실패");
    } finally {
      setDeleting(false);
    }
  };

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

          {item.linked_file_download_path ? (
            <div className="rounded border border-stone-200 bg-white px-3 py-2">
              <p className="text-xs font-semibold text-stone-700">연결 첨부파일</p>
              <a
                href={buildApiUrl(item.linked_file_download_path)}
                className="mt-1 inline-flex max-w-full items-center gap-1 rounded border border-stone-300 bg-stone-50 px-2 py-1 text-sm text-stone-800 hover:bg-stone-100"
                title={item.linked_file_name || "첨부파일 다운로드"}
                download
              >
                <Paperclip className="h-4 w-4 shrink-0 text-stone-600" />
                <span className="truncate">{item.linked_file_name || "첨부파일 다운로드"}</span>
              </a>
            </div>
          ) : null}

          {actionError ? <p className="text-sm text-red-700">작업 실패: {actionError}</p> : null}

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              type="button"
              className="inline-flex items-center rounded border border-stone-300 bg-white px-3 py-1.5 text-xs hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => router.push(`/dashboard?edit_task_id=${item.id}`)}
              disabled={deleting}
            >
              수정
            </button>
            <button
              type="button"
              className="inline-flex items-center rounded border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void deleteTask()}
              disabled={deleting}
            >
              {deleting ? "삭제 중..." : "삭제"}
            </button>
            <Link href="/dashboard" className="inline-flex items-center rounded border border-stone-300 px-3 py-1.5 text-xs hover:bg-stone-50">
              대시보드로 돌아가기
            </Link>
          </div>
        </article>
      ) : null}
    </section>
  );
}

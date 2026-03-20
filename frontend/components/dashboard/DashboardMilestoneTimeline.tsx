"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarRange,
  Crosshair,
  ListChecks,
  Pencil,
  Plus,
  Route,
  Save,
  Trash2,
} from "lucide-react";

import { ModalShell } from "@/components/common/ModalShell";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api-client";

type DashboardMilestoneItem = {
  id: string;
  title: string;
  start_date: string;
  end_date: string | null;
  description: string;
  color: string | null;
  created_at: string;
  updated_at: string;
};

type DashboardMilestoneListResponse = {
  start_year: number;
  end_year: number;
  items: DashboardMilestoneItem[];
  generated_at: string;
};

type DashboardMilestonePayload = {
  title: string;
  start_date: string;
  end_date: string | null;
  description: string;
  color: string | null;
};

const TIMELINE_START_YEAR = 2025;
const TIMELINE_END_YEAR = 2032;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MILESTONE_COLOR = "#0F766E";

function timelineStartDate(): Date {
  return new Date(TIMELINE_START_YEAR, 0, 1, 0, 0, 0, 0);
}

function timelineEndDate(): Date {
  return new Date(TIMELINE_END_YEAR, 11, 31, 23, 59, 59, 999);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function percentFromDate(value: string | Date): number {
  const dt = typeof value === "string" ? new Date(`${value}T00:00:00`) : value;
  const start = timelineStartDate().getTime();
  const end = timelineEndDate().getTime();
  const current = dt.getTime();
  if (Number.isNaN(current) || end <= start) return 0;
  return clamp((current - start) / (end - start), 0, 1);
}

function formatDateRange(startDate: string, endDate: string | null): string {
  if (!endDate || endDate === startDate) return startDate;
  return `${startDate} ~ ${endDate}`;
}

function todayDateKey(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeColor(color: string): string {
  const trimmed = color.trim();
  return /^#[0-9A-Fa-f]{6}$/.test(trimmed) ? trimmed.toUpperCase() : DEFAULT_MILESTONE_COLOR;
}

function easedPercent(basePercent: number, hoverPercent: number | null): number {
  if (hoverPercent == null) return basePercent;
  const distance = basePercent - hoverPercent;
  const influence = Math.max(0, 1 - Math.abs(distance) / 0.16);
  return clamp(basePercent + distance * influence * 0.36, 0, 1);
}

function buildEmptyForm(): DashboardMilestonePayload {
  return {
    title: "",
    start_date: todayDateKey(),
    end_date: null,
    description: "",
    color: DEFAULT_MILESTONE_COLOR,
  };
}

export function DashboardMilestoneTimeline() {
  const [items, setItems] = useState<DashboardMilestoneItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [hoverPercent, setHoverPercent] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<DashboardMilestonePayload>(buildEmptyForm());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadMilestones = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiGet<DashboardMilestoneListResponse>(
        `/dashboard/milestones?start_year=${TIMELINE_START_YEAR}&end_year=${TIMELINE_END_YEAR}`,
      );
      setItems(res.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "마일스톤 로드 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMilestones();
  }, [loadMilestones]);

  const sortedItems = useMemo(
    () =>
      [...items].sort((a, b) => {
        const byStart = a.start_date.localeCompare(b.start_date);
        if (byStart !== 0) return byStart;
        return a.title.localeCompare(b.title, "ko");
      }),
    [items],
  );

  const currentPercent = useMemo(() => percentFromDate(new Date()), []);

  const hoveredItems = useMemo(() => {
    if (hoverPercent == null) return [];
    const hoveredTime =
      timelineStartDate().getTime() + (timelineEndDate().getTime() - timelineStartDate().getTime()) * hoverPercent;
    return [...sortedItems]
      .map((item) => {
        const startTime = new Date(`${item.start_date}T00:00:00`).getTime();
        const endTime = new Date(`${item.end_date || item.start_date}T23:59:59`).getTime();
        const centerTime = startTime + (endTime - startTime) / 2;
        const distance = Math.abs(centerTime - hoveredTime);
        return { item, distance };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 4)
      .filter((entry) => entry.distance <= 120 * DAY_MS);
  }, [hoverPercent, sortedItems]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setForm(buildEmptyForm());
    setSaveError("");
    setNotice("");
  }, []);

  const startCreate = useCallback(() => {
    setDetailOpen(true);
    resetForm();
  }, [resetForm]);

  const startEdit = useCallback((item: DashboardMilestoneItem) => {
    setDetailOpen(true);
    setEditingId(item.id);
    setForm({
      title: item.title,
      start_date: item.start_date,
      end_date: item.end_date,
      description: item.description || "",
      color: item.color || DEFAULT_MILESTONE_COLOR,
    });
    setSaveError("");
    setNotice("");
  }, []);

  const submitMilestone = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setSaving(true);
      setSaveError("");
      setNotice("");
      try {
        const payload = {
          title: form.title.trim(),
          start_date: form.start_date,
          end_date: form.end_date?.trim() ? form.end_date : null,
          description: form.description.trim(),
          color: form.color?.trim() ? normalizeColor(form.color) : null,
        };
        if (!payload.title) {
          throw new Error("제목을 입력해주세요.");
        }
        if (!payload.start_date) {
          throw new Error("시작일을 입력해주세요.");
        }
        if (editingId) {
          await apiPatch<DashboardMilestoneItem>(`/dashboard/milestones/${encodeURIComponent(editingId)}`, payload);
          setNotice("마일스톤을 수정했습니다.");
        } else {
          await apiPost<DashboardMilestoneItem>("/dashboard/milestones", payload);
          setNotice("마일스톤을 추가했습니다.");
        }
        await loadMilestones();
        resetForm();
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "마일스톤 저장 실패");
      } finally {
        setSaving(false);
      }
    },
    [editingId, form, loadMilestones, resetForm],
  );

  const deleteMilestone = useCallback(
    async (item: DashboardMilestoneItem) => {
      if (!window.confirm(`마일스톤을 삭제할까요?\n${item.title}`)) return;
      setDeletingId(item.id);
      setSaveError("");
      setNotice("");
      try {
        await apiDelete<unknown>(`/dashboard/milestones/${encodeURIComponent(item.id)}`);
        setNotice("마일스톤을 삭제했습니다.");
        await loadMilestones();
        if (editingId === item.id) {
          resetForm();
        }
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "마일스톤 삭제 실패");
      } finally {
        setDeletingId(null);
      }
    },
    [editingId, loadMilestones, resetForm],
  );

  return (
    <>
      <article className="rounded-lg border border-stone-200 bg-panel px-4 py-3 shadow-panel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex items-center gap-2">
            <h2 className="inline-flex items-center gap-1 text-sm font-semibold text-stone-700">
              <Route className="h-4 w-4 text-accent" />
              중장기 마일스톤
            </h2>
            <span className="rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[10px] font-semibold text-stone-600">
              {TIMELINE_START_YEAR.toString().slice(2)}년~{TIMELINE_END_YEAR.toString().slice(2)}년
            </span>
          </div>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => setDetailOpen(true)}
              className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-50"
            >
              <ListChecks className="h-3.5 w-3.5" />
              상세보기
            </button>
            <button
              type="button"
              onClick={startCreate}
              className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-50"
            >
              <Plus className="h-3.5 w-3.5" />
              추가
            </button>
          </div>
        </div>

        <div
          className="relative mt-3 rounded-xl border border-stone-200 bg-[linear-gradient(90deg,#f5f5f4_0%,#fafaf9_45%,#f5f5f4_100%)] px-3 py-3"
          onMouseLeave={() => setHoverPercent(null)}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.width <= 0) return;
            setHoverPercent(clamp((event.clientX - rect.left) / rect.width, 0, 1));
          }}
        >
          <div className="pointer-events-none absolute inset-x-3 top-1/2 h-px -translate-y-1/2 bg-stone-300" />
          {Array.from({ length: TIMELINE_END_YEAR - TIMELINE_START_YEAR + 1 }).map((_, index) => {
            const year = TIMELINE_START_YEAR + index;
            const tickPercent = index / (TIMELINE_END_YEAR - TIMELINE_START_YEAR || 1);
            return (
              <div key={year} className="pointer-events-none absolute bottom-1 top-2" style={{ left: `${tickPercent * 100}%` }}>
                <div className="absolute bottom-4 top-0 w-px bg-stone-200" />
                <span className="absolute bottom-0 -translate-x-1/2 text-[10px] font-semibold text-stone-500">{String(year).slice(2)}</span>
              </div>
            );
          })}

          <div className="pointer-events-none absolute inset-y-2 z-[1] w-px bg-rose-500/80" style={{ left: `${currentPercent * 100}%` }}>
            <span className="absolute -top-5 left-1/2 -translate-x-1/2 rounded-full bg-rose-500 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow-sm">
              현재
            </span>
          </div>

          <div className="relative h-10">
            {loading ? <p className="pt-2 text-xs text-stone-500">마일스톤 로딩 중...</p> : null}
            {!loading && error ? <p className="pt-2 text-xs text-red-700">{error}</p> : null}
            {!loading && !error && sortedItems.length === 0 ? <p className="pt-2 text-xs text-stone-500">등록된 마일스톤이 없습니다.</p> : null}
            {!loading &&
              !error &&
              sortedItems.map((item, index) => {
                const color = normalizeColor(item.color || DEFAULT_MILESTONE_COLOR);
                const startPercent = easedPercent(percentFromDate(item.start_date), hoverPercent);
                const endPercent = easedPercent(percentFromDate(item.end_date || item.start_date), hoverPercent);
                const left = Math.min(startPercent, endPercent) * 100;
                const width = Math.max(0.75, Math.abs(endPercent - startPercent) * 100);
                const rowOffset = index % 2 === 0 ? 6 : 22;
                const isRange = Boolean(item.end_date && item.end_date !== item.start_date);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => startEdit(item)}
                    className="group absolute top-0 h-4 rounded-full transition-transform hover:z-10 hover:scale-[1.03]"
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      minWidth: isRange ? "12px" : "10px",
                      transform: `translateY(${rowOffset}px)`,
                      backgroundColor: color,
                      boxShadow: hoverPercent != null ? "0 6px 12px rgba(0,0,0,0.16)" : "0 4px 10px rgba(0,0,0,0.12)",
                    }}
                    title={`${item.title} · ${formatDateRange(item.start_date, item.end_date)}`}
                  >
                    {!isRange ? <span className="absolute inset-0 rounded-full border-2 border-white/70" /> : null}
                    <span className="pointer-events-none absolute left-1/2 top-[-20px] hidden max-w-[180px] -translate-x-1/2 truncate rounded-full border border-stone-300 bg-white/95 px-2 py-0.5 text-[10px] font-semibold text-stone-700 shadow-sm group-hover:block">
                      {item.title}
                    </span>
                  </button>
                );
              })}
          </div>

          {hoveredItems.length > 0 ? (
            <div
              className="pointer-events-none absolute top-[calc(100%+8px)] z-20 w-64 rounded-lg border border-stone-200 bg-white/95 p-2 shadow-xl backdrop-blur"
              style={{ left: `${clamp((hoverPercent || 0) * 100, 12, 88)}%`, transform: "translateX(-50%)" }}
            >
              <p className="inline-flex items-center gap-1 text-[10px] font-semibold text-stone-500">
                <Crosshair className="h-3 w-3 text-accent" />
                밀집 구간 확대
              </p>
              <ul className="mt-1.5 space-y-1">
                {hoveredItems.map(({ item }) => (
                  <li key={`hover-${item.id}`} className="rounded border border-stone-200 px-2 py-1">
                    <p className="text-[11px] font-semibold text-stone-800">{item.title}</p>
                    <p className="text-[10px] text-stone-500">{formatDateRange(item.start_date, item.end_date)}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </article>

      <ModalShell
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          resetForm();
        }}
        title="마일스톤 상세"
        maxWidthClassName="max-w-6xl"
      >
        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <form className="space-y-3 rounded-xl border border-stone-200 bg-stone-50/80 p-3" onSubmit={(event) => void submitMilestone(event)}>
            <div className="flex items-center justify-between gap-2">
              <p className="inline-flex items-center gap-1 text-sm font-semibold text-stone-700">
                <CalendarRange className="h-4 w-4 text-accent" />
                {editingId ? "마일스톤 수정" : "마일스톤 추가"}
              </p>
              {editingId ? (
                <button
                  type="button"
                  onClick={resetForm}
                  className="rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-50"
                >
                  새로 입력
                </button>
              ) : null}
            </div>

            <label className="space-y-1 text-xs">
              <span className="text-stone-700">제목 *</span>
              <input
                className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={form.title}
                onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                maxLength={180}
                required
              />
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="text-stone-700">시작일 *</span>
                <input
                  type="date"
                  className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                  value={form.start_date}
                  onChange={(event) => setForm((prev) => ({ ...prev, start_date: event.target.value }))}
                  required
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-stone-700">종료일</span>
                <input
                  type="date"
                  className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                  value={form.end_date || ""}
                  onChange={(event) => setForm((prev) => ({ ...prev, end_date: event.target.value || null }))}
                />
              </label>
            </div>

            <label className="space-y-1 text-xs">
              <span className="text-stone-700">색상</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  className="h-9 w-12 cursor-pointer rounded border border-stone-300 bg-white p-1"
                  value={normalizeColor(form.color || DEFAULT_MILESTONE_COLOR)}
                  onChange={(event) => setForm((prev) => ({ ...prev, color: event.target.value }))}
                />
                <input
                  className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                  value={form.color || ""}
                  onChange={(event) => setForm((prev) => ({ ...prev, color: event.target.value }))}
                  placeholder="#0F766E"
                  maxLength={7}
                />
              </div>
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-stone-700">상세 설명</span>
              <textarea
                className="min-h-[140px] w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
                value={form.description}
                onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                placeholder="상세 보기 팝업에서 길게 확인할 설명을 입력하세요."
                maxLength={2000}
              />
            </label>

            {saveError ? <p className="text-xs text-red-700">{saveError}</p> : null}
            {notice ? <p className="text-xs text-amber-700">{notice}</p> : null}

            <div className="flex justify-end gap-2">
              <button
                type="submit"
                className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                disabled={saving}
              >
                <Save className="h-3.5 w-3.5" />
                {saving ? "저장 중..." : editingId ? "수정 저장" : "추가 저장"}
              </button>
            </div>
          </form>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-stone-700">전체 마일스톤</p>
              <span className="text-xs text-stone-500">스크롤로 전체 목록 확인</span>
            </div>
            <div className="max-h-[68vh] space-y-2 overflow-y-auto rounded-xl border border-stone-200 bg-white p-2">
              {sortedItems.length === 0 ? <p className="text-sm text-stone-500">등록된 마일스톤이 없습니다.</p> : null}
              {sortedItems.map((item) => {
                const active = item.id === editingId;
                return (
                  <article
                    key={item.id}
                    className={`rounded-lg border p-3 ${active ? "border-accent bg-emerald-50/50" : "border-stone-200 bg-stone-50/50"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-flex h-3 w-3 shrink-0 rounded-full border border-white shadow-sm"
                            style={{ backgroundColor: normalizeColor(item.color || DEFAULT_MILESTONE_COLOR) }}
                          />
                          <p className="truncate text-sm font-semibold text-stone-900">{item.title}</p>
                        </div>
                        <p className="mt-1 text-xs text-stone-500">{formatDateRange(item.start_date, item.end_date)}</p>
                      </div>
                      <div className="inline-flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => startEdit(item)}
                          className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-50"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          수정
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteMilestone(item)}
                          className="inline-flex items-center gap-1 rounded border border-red-300 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-60"
                          disabled={deletingId === item.id}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {deletingId === item.id ? "삭제 중..." : "삭제"}
                        </button>
                      </div>
                    </div>
                    {item.description ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-700">{item.description}</p> : null}
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      </ModalShell>
    </>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, ExternalLink, Eye, FileText, Link2, Pencil, Pin } from "lucide-react";

import { apiDelete, apiGet, apiPatch, apiPostForm, buildApiUrl } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";
import { PageMenuHeading } from "@/components/layout/PageMenuHeading";
import { reviewStatusLabel } from "@/lib/labels";
import { SafeRichContentEditor } from "@/components/editor/SafeRichContentEditor";
import { RichContentView } from "@/components/editor/RichContentView";
import { DocumentCommentsPanel } from "@/components/documents/DocumentCommentsPanel";
import { normalizeRichContentHtml } from "@/lib/rich-content";

type ReviewStatus = "NONE" | "NEEDS_REVIEW" | "RESOLVED";
type DetailMode = "view" | "edit";

type DocumentFileItem = {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  download_path?: string;
};

type DocumentVersionItem = {
  version_no: number;
  changed_at: string;
  change_reason: string;
  title: string;
  event_date: string | null;
};

type DocumentVersionDiffResponse = {
  document_id: string;
  from_version_no: number;
  to_version_no: number;
  changed_fields: string[];
  title_from: string;
  title_to: string;
  description_diff: string;
  summary_diff: string;
  tags_from: string[];
  tags_to: string[];
  event_date_from: string | null;
  event_date_to: string | null;
  category_id_from: string | null;
  category_id_to: string | null;
};

type DocumentVersionSnapshotResponse = {
  document_id: string;
  version_no: number;
  changed_at: string;
  change_reason: string;
  title: string;
  description: string;
  summary: string;
  category_id: string | null;
  category: string | null;
  event_date: string | null;
  tags: string[];
};

type DocumentDetailResponse = {
  id: string;
  source: string;
  source_ref: string | null;
  title: string;
  description: string;
  caption_raw: string;
  summary: string;
  category_id?: string | null;
  category: string | null;
  categories?: string[];
  event_date: string | null;
  ingested_at: string;
  is_pinned: boolean;
  pinned_at: string | null;
  review_status: ReviewStatus;
  tags: string[];
  files: DocumentFileItem[];
  versions: DocumentVersionItem[];
};

type ManualPostCategoryOptionsResponse = {
  categories: string[];
};

interface PageProps {
  params: { id: string };
}

function formatDateTime(value: string): string {
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? "-" : dt.toLocaleString("ko-KR");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function fileDownloadUrl(downloadPath: string | undefined, fileId: string): string {
  return buildApiUrl(downloadPath || `/files/${fileId}/download`);
}

function parseTagInput(value: string): string[] {
  return value
    .split(/[,\n]/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function hasMeaningfulRichText(value: string | null | undefined): boolean {
  if (!value) return false;
  const stripped = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 && stripped !== "-";
}

function documentPermalink(documentId: string): string {
  const path = `/documents/${documentId}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

export default function DocumentDetailPage({ params }: PageProps) {
  const router = useRouter();
  const [detail, setDetail] = useState<DocumentDetailResponse | null>(null);
  const [mode, setMode] = useState<DetailMode>("view");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [diffFromVersionNo, setDiffFromVersionNo] = useState<number>(1);
  const [diffToVersionNo, setDiffToVersionNo] = useState<number>(1);
  const [versionDiff, setVersionDiff] = useState<DocumentVersionDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [versionSnapshot, setVersionSnapshot] = useState<DocumentVersionSnapshotResponse | null>(null);
  const [versionSnapshotLoading, setVersionSnapshotLoading] = useState(false);
  const [versionSnapshotError, setVersionSnapshotError] = useState("");
  const [selectedVersionNo, setSelectedVersionNo] = useState<number | null>(null);

  const [editTitle, setEditTitle] = useState("");
  const [editDescriptionHtml, setEditDescriptionHtml] = useState("<p></p>");
  const [editSummary, setEditSummary] = useState("");
  const [editCategoryNames, setEditCategoryNames] = useState<string[]>([]);
  const [customCategoryName, setCustomCategoryName] = useState("");
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  const [categoryOptionsLoading, setCategoryOptionsLoading] = useState(true);
  const [categoryOptionsError, setCategoryOptionsError] = useState("");
  const [editEventDate, setEditEventDate] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editIsPinned, setEditIsPinned] = useState(false);
  const [editReviewStatus, setEditReviewStatus] = useState<ReviewStatus>("NONE");
  const [addFiles, setAddFiles] = useState<File[]>([]);
  const [addFilesInputKey, setAddFilesInputKey] = useState(0);
  const permalink = useMemo(() => documentPermalink(params.id), [params.id]);

  useEffect(() => {
    let cancelled = false;
    async function loadDetail() {
      setLoading(true);
      setError("");
      try {
        const res = await apiGet<DocumentDetailResponse>(`/documents/${params.id}`);
        if (!cancelled) {
          setDetail(res);
          setMode("view");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "문서 조회 실패");
          setDetail(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  useEffect(() => {
    let cancelled = false;
    async function loadCategoryOptions() {
      setCategoryOptionsLoading(true);
      setCategoryOptionsError("");
      try {
        const res = await apiGet<ManualPostCategoryOptionsResponse>("/documents/manual-post/category-options");
        if (cancelled) return;
        const names = Array.from(
          new Set(
            (res.categories ?? [])
              .map((name) => name?.trim())
              .filter((name): name is string => Boolean(name)),
          ),
        );
        setCategoryOptions(names);
      } catch (err) {
        if (!cancelled) {
          setCategoryOptionsError(err instanceof Error ? err.message : "카테고리 목록 로드 실패");
          setCategoryOptions([]);
        }
      } finally {
        if (!cancelled) setCategoryOptionsLoading(false);
      }
    }
    void loadCategoryOptions();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!detail) {
      setEditTitle("");
      setEditDescriptionHtml("<p></p>");
      setEditSummary("");
      setEditCategoryNames([]);
      setCustomCategoryName("");
      setEditEventDate("");
      setEditTags("");
      setEditIsPinned(false);
      setEditReviewStatus("NONE");
      setAddFiles([]);
      setAddFilesInputKey((prev) => prev + 1);
      setVersionSnapshot(null);
      setVersionSnapshotError("");
      setSelectedVersionNo(null);
      return;
    }

    setEditTitle(detail.title);
    setEditDescriptionHtml(normalizeRichContentHtml(detail.description || ""));
    setEditSummary(detail.summary || "");
    const initialCategories = Array.from(
      new Set(
        (detail.categories && detail.categories.length > 0 ? detail.categories : detail.category ? [detail.category] : [])
          .map((name) => name?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    );
    setEditCategoryNames(initialCategories);
    setCustomCategoryName("");
    setEditEventDate(detail.event_date || "");
    setEditTags(detail.tags.join(", "));
    setEditIsPinned(detail.is_pinned);
    setEditReviewStatus(detail.review_status);
    setAddFiles([]);
    setAddFilesInputKey((prev) => prev + 1);

    if (detail.versions.length > 0) {
      const to = detail.versions[0].version_no;
      const from = detail.versions[1]?.version_no ?? detail.versions[0].version_no;
      setDiffToVersionNo(to);
      setDiffFromVersionNo(from);
    } else {
      setDiffToVersionNo(1);
      setDiffFromVersionNo(1);
    }
    setVersionSnapshot(null);
    setVersionSnapshotError("");
    setSelectedVersionNo(null);
  }, [detail]);

  useEffect(() => {
    if (!detail || detail.versions.length === 0) {
      setVersionDiff(null);
      return;
    }
    if (diffFromVersionNo > diffToVersionNo) {
      setVersionDiff(null);
      return;
    }
    const docId = detail.id;

    let cancelled = false;
    async function loadVersionDiff() {
      setDiffLoading(true);
      setDiffError("");
      try {
        const res = await apiGet<DocumentVersionDiffResponse>(
          `/documents/${docId}/versions/diff?from_version_no=${diffFromVersionNo}&to_version_no=${diffToVersionNo}`,
        );
        if (!cancelled) setVersionDiff(res);
      } catch (err) {
        if (!cancelled) {
          setDiffError(err instanceof Error ? err.message : "버전 diff 조회 실패");
          setVersionDiff(null);
        }
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    }
    void loadVersionDiff();
    return () => {
      cancelled = true;
    };
  }, [detail, diffFromVersionNo, diffToVersionNo]);

  const toggleCategorySelection = (categoryName: string) => {
    const normalized = categoryName.trim();
    if (!normalized) return;
    setEditCategoryNames((prev) => {
      if (prev.includes(normalized)) {
        return prev.filter((name) => name !== normalized);
      }
      return [...prev, normalized];
    });
  };

  const addCustomCategorySelection = () => {
    const normalized = customCategoryName.trim();
    if (!normalized) return;
    setEditCategoryNames((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
    setCustomCategoryName("");
  };

  const removeCategorySelection = (categoryName: string) => {
    setEditCategoryNames((prev) => prev.filter((name) => name !== categoryName));
  };

  const resetEditState = () => {
    if (!detail) return;
    setEditTitle(detail.title);
    setEditDescriptionHtml(normalizeRichContentHtml(detail.description || ""));
    setEditSummary(detail.summary || "");
    const initialCategories = Array.from(
      new Set(
        (detail.categories && detail.categories.length > 0 ? detail.categories : detail.category ? [detail.category] : [])
          .map((name) => name?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    );
    setEditCategoryNames(initialCategories);
    setCustomCategoryName("");
    setEditEventDate(detail.event_date || "");
    setEditTags(detail.tags.join(", "));
    setEditIsPinned(detail.is_pinned);
    setEditReviewStatus(detail.review_status);
    setMode("view");
  };

  const saveDocument = async () => {
    if (!detail) return;
    if (!editTitle.trim()) {
      setActionError("제목은 비워둘 수 없습니다.");
      return;
    }
    setActionBusy(true);
    setActionError("");
    setNotice("");
    try {
      const payload = {
        title: editTitle.trim(),
        description: normalizeRichContentHtml(editDescriptionHtml),
        summary: editSummary,
        category_name: editCategoryNames[0] || null,
        category_names: editCategoryNames,
        event_date: editEventDate || null,
        tags: parseTagInput(editTags),
        is_pinned: editIsPinned,
        review_status: editReviewStatus,
      };
      const res = await apiPatch<DocumentDetailResponse>(`/documents/${detail.id}`, payload);
      setDetail(res);
      setMode("view");
      setNotice("문서 저장이 완료되었습니다.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "문서 저장 실패");
    } finally {
      setActionBusy(false);
    }
  };

  const addDocumentFiles = async () => {
    if (!detail) return;
    if (addFiles.length === 0) {
      setActionError("추가할 첨부파일을 선택하세요.");
      return;
    }
    const uploadCount = addFiles.length;
    setActionBusy(true);
    setActionError("");
    setNotice("");
    try {
      const form = new FormData();
      for (const file of addFiles) {
        form.append("files", file);
      }
      form.append("change_reason", "manual_file_add_ui");
      const res = await apiPostForm<DocumentDetailResponse>(`/documents/${detail.id}/files`, form);
      setDetail(res);
      setAddFiles([]);
      setAddFilesInputKey((prev) => prev + 1);
      setNotice(`첨부파일 ${uploadCount}개 추가가 완료되었습니다.`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "첨부파일 추가 실패");
    } finally {
      setActionBusy(false);
    }
  };

  const deleteDocument = async () => {
    if (!detail) return;
    const confirmed = window.confirm(`문서를 삭제하시겠습니까?\n${detail.title}`);
    if (!confirmed) return;

    setActionBusy(true);
    setActionError("");
    setNotice("");
    try {
      await apiDelete<{ status: string; document_id: string }>(`/documents/${detail.id}`);
      router.push("/archive");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "문서 삭제 실패");
      setActionBusy(false);
    }
  };

  const loadVersionSnapshot = async (versionNo: number) => {
    if (!detail) return;
    setVersionSnapshotLoading(true);
    setVersionSnapshotError("");
    setSelectedVersionNo(versionNo);
    try {
      const res = await apiGet<DocumentVersionSnapshotResponse>(`/documents/${detail.id}/versions/${versionNo}/snapshot`);
      setVersionSnapshot(res);
    } catch (err) {
      setVersionSnapshot(null);
      setVersionSnapshotError(err instanceof Error ? err.message : "버전 스냅샷 조회 실패");
    } finally {
      setVersionSnapshotLoading(false);
    }
  };

  const viewDescriptionHtml = useMemo(() => normalizeRichContentHtml(detail?.description || ""), [detail?.description]);
  const detailAttachmentLinks = useMemo(
    () =>
      (detail?.files ?? []).map((file) => ({
        label: file.original_filename,
        href: fileDownloadUrl(file.download_path, file.id),
      })),
    [detail?.files],
  );

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <PageMenuHeading title="문서 상세" href={`/documents/${params.id}`} />
        <div className="flex items-center gap-2">
          {mode === "view" ? (
            <button
              className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-3 py-1 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              onClick={() => setMode("edit")}
              disabled={actionBusy || loading || !detail}
            >
              <Pencil className="h-4 w-4" />
              편집 모드
            </button>
          ) : (
            <>
              <button
                className="inline-flex items-center gap-1 rounded border border-emerald-600 bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
                onClick={() => void saveDocument()}
                disabled={actionBusy || loading || !detail}
              >
                <Pencil className="h-4 w-4" />
                {actionBusy ? "저장 중..." : "수정 저장"}
              </button>
              <button
                className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-3 py-1 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                onClick={resetEditState}
                disabled={actionBusy || loading || !detail}
              >
                <Eye className="h-4 w-4" />
                보기 전환
              </button>
            </>
          )}
          <button
            className="rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
            onClick={() => void deleteDocument()}
            disabled={actionBusy || loading || !detail}
          >
            {actionBusy ? "처리 중..." : "문서 삭제"}
          </button>
          <Link className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-50" href="/archive">
            아카이브로 이동
          </Link>
        </div>
      </div>

      {loading ? <p className="text-sm text-stone-600">문서 로딩 중...</p> : null}
      {error ? <p className="text-sm text-red-700">상세 조회 오류: {error}</p> : null}
      {actionError ? <p className="text-sm text-red-700">상세 처리 오류: {actionError}</p> : null}
      {notice ? <p className="text-sm text-emerald-700">{notice}</p> : null}

      {!loading && !error && detail ? (
        <article className="rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
          <h2 className="text-2xl font-semibold text-stone-900">{detail.title}</h2>
          <p className="mt-1 text-sm text-stone-600">
            카테고리 {(detail.categories && detail.categories.length > 0 ? detail.categories.join(", ") : detail.category || "미분류")} | 이벤트일 {detail.event_date || "-"} | 수집 {formatDateTime(detail.ingested_at)} | 상태{" "}
            {reviewStatusLabel(detail.review_status)}
          </p>
          <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
            <p className="inline-flex items-center gap-1 text-xs font-semibold text-stone-700">
              <Link2 className="h-3.5 w-3.5 text-accent" />
              게시물 링크
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <a
                href={permalink}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-sm text-cyan-700 underline underline-offset-2"
                title={permalink}
              >
                {permalink}
              </a>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-100"
                onClick={async () => {
                  try {
                    await copyText(permalink);
                    setNotice("게시물 링크를 복사했습니다.");
                  } catch {
                    setActionError("게시물 링크 복사에 실패했습니다.");
                  }
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                링크 복사
              </button>
              <a
                href={permalink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-100"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                새 창 열기
              </a>
            </div>
          </div>
          {detail.is_pinned ? (
            <p className="mt-1 inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">
              <Pin className="h-3.5 w-3.5" />
              고정글
            </p>
          ) : null}

          {mode === "edit" ? (
            <section className="mt-4 space-y-3 rounded border border-stone-200 bg-stone-50 p-3">
              <p className="inline-flex items-center gap-1 text-sm font-semibold text-stone-800">
                <Pencil className="h-4 w-4" />
                리치 편집 모드
              </p>
              <div className="grid gap-2 lg:grid-cols-2">
                <input
                  className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="제목"
                />
                <input
                  className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                  type="date"
                  value={editEventDate}
                  onChange={(e) => setEditEventDate(e.target.value)}
                />
              </div>
              <div className="space-y-2 rounded border border-stone-200 p-2">
                <p className="text-xs font-semibold text-stone-700">카테고리(복수 선택 가능)</p>
                <div className="grid max-h-28 grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-2 gap-y-1 overflow-auto rounded border border-stone-200 bg-white p-2">
                  {categoryOptions.map((name) => (
                    <label key={name} className="flex min-w-0 items-center gap-2 text-xs text-stone-700">
                      <input type="checkbox" checked={editCategoryNames.includes(name)} onChange={() => toggleCategorySelection(name)} />
                      <span className="truncate">{name}</span>
                    </label>
                  ))}
                  {categoryOptions.length === 0 ? <p className="text-xs text-stone-500">등록된 카테고리가 없습니다.</p> : null}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                    value={customCategoryName}
                    onChange={(e) => setCustomCategoryName(e.target.value)}
                    placeholder="신규 카테고리명"
                  />
                  <button
                    type="button"
                    className="rounded border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-50"
                    onClick={addCustomCategorySelection}
                  >
                    추가
                  </button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {editCategoryNames.length === 0 ? <span className="text-[11px] text-stone-500">선택된 카테고리 없음</span> : null}
                  {editCategoryNames.map((name, idx) => (
                    <button
                      key={name}
                      type="button"
                      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] ${idx === 0 ? "border-accent bg-accent/10 text-accent" : "border-stone-300 bg-white text-stone-700"}`}
                      title={idx === 0 ? "기본 카테고리" : "보조 카테고리"}
                      onClick={() => removeCategorySelection(name)}
                    >
                      <span>{name}</span>
                      <span>×</span>
                    </button>
                  ))}
                </div>
              </div>
              {categoryOptionsLoading ? <p className="text-xs text-stone-500">카테고리 목록 로딩 중...</p> : null}
              {categoryOptionsError ? <p className="text-xs text-amber-700">목록 로드 실패: {categoryOptionsError}</p> : null}

              <SafeRichContentEditor
                value={editDescriptionHtml}
                onChange={setEditDescriptionHtml}
                minHeightClassName="min-h-[320px]"
                attachmentLinks={detailAttachmentLinks}
              />
              <textarea
                className="min-h-20 w-full rounded border border-stone-300 px-2 py-1 text-sm"
                value={editSummary}
                onChange={(e) => setEditSummary(e.target.value)}
                placeholder="요약 (비워두면 빈 요약으로 저장됩니다)"
              />

              <textarea
                className="min-h-16 w-full rounded border border-stone-300 px-2 py-1 text-sm"
                value={editTags}
                onChange={(e) => setEditTags(e.target.value)}
                placeholder="태그(쉼표 또는 줄바꿈)"
              />
              <div className="grid gap-2 lg:grid-cols-2">
                <label className="inline-flex items-center gap-2 rounded border border-stone-300 bg-white px-2 py-1 text-sm text-stone-700">
                  <input
                    type="checkbox"
                    checked={editIsPinned}
                    onChange={(e) => setEditIsPinned(e.target.checked)}
                  />
                  고정글로 설정 (대시보드 카테고리별 고정글 노출)
                </label>
                <select
                  className="w-full rounded border border-stone-300 px-2 py-1 text-sm"
                  value={editReviewStatus}
                  onChange={(e) => setEditReviewStatus(e.target.value as ReviewStatus)}
                >
                  <option value="NONE">{reviewStatusLabel("NONE")}</option>
                  <option value="NEEDS_REVIEW">{reviewStatusLabel("NEEDS_REVIEW")}</option>
                  <option value="RESOLVED">{reviewStatusLabel("RESOLVED")}</option>
                </select>
              </div>
            </section>
          ) : (
            <section className="mt-4 rounded border border-stone-200 bg-white p-5">
              <p className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-stone-700">
                <FileText className="h-4 w-4" />
                문서 본문
              </p>
              <RichContentView html={viewDescriptionHtml} className="mx-auto max-w-none" />
            </section>
          )}

          {mode === "view" && hasMeaningfulRichText(detail.summary) ? (
            <section className="mt-4 rounded border border-stone-200 p-3">
              <p className="mb-1 text-sm font-semibold text-stone-800">요약</p>
              <RichContentView html={normalizeRichContentHtml(detail.summary)} className="text-sm" />
            </section>
          ) : null}

          <section className="mt-3">
            <DocumentCommentsPanel documentId={detail.id} />
          </section>

          <section className="mt-3 rounded border border-stone-200 p-3">
            <p className="mb-1 text-sm font-semibold text-stone-800">파일 목록</p>
            <div className="mb-3 space-y-2 rounded border border-stone-200 bg-stone-50 p-2">
              <p className="text-xs font-semibold text-stone-700">첨부파일 추가</p>
              <input
                key={addFilesInputKey}
                className="w-full rounded border border-stone-300 px-2 py-1 text-xs"
                type="file"
                multiple
                onChange={(e) => setAddFiles(Array.from(e.target.files ?? []))}
              />
              {addFiles.length > 0 ? (
                <p className="line-clamp-3 break-all text-[11px] text-stone-600">{addFiles.map((file) => file.name).join(", ")}</p>
              ) : null}
              <button
                className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100 disabled:opacity-50"
                onClick={() => void addDocumentFiles()}
                disabled={actionBusy || loading || !detail || addFiles.length === 0}
              >
                {actionBusy ? "처리 중..." : `선택 파일 ${addFiles.length || 0}개 추가`}
              </button>
            </div>
            {detail.files.length === 0 ? <p className="text-sm text-stone-600">파일 없음</p> : null}
            <ul className="space-y-2">
              {detail.files.map((file) => (
                <li key={file.id} className="rounded border border-stone-200 p-2 text-sm">
                  <a
                    className="inline-flex min-w-0 items-center gap-1 font-medium text-blue-700 hover:underline"
                    href={fileDownloadUrl(file.download_path, file.id)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="truncate">{file.original_filename}</span>
                  </a>
                  <p className="text-xs text-stone-600">
                    {file.mime_type} | {formatBytes(file.size_bytes)}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          {mode === "view" ? (
            <section className="mt-3 rounded border border-stone-200 p-3">
              <details className="rounded border border-stone-200 bg-stone-50 p-2">
                <summary className="cursor-pointer select-none text-sm font-semibold text-stone-800">원본 캡션 펼치기</summary>
                <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded border border-stone-100 bg-white p-2 text-xs text-stone-700">
                  {detail.caption_raw || "-"}
                </pre>
              </details>
            </section>
          ) : null}

          <section className="mt-3 rounded border border-stone-200 p-3">
            <p className="mb-1 text-sm font-semibold text-stone-800">버전 히스토리</p>
            {detail.versions.length === 0 ? <p className="text-sm text-stone-600">버전 없음</p> : null}
            <ul className="space-y-1">
              {detail.versions.map((version) => (
                <li key={`${detail.id}-v-${version.version_no}`} className="text-xs text-stone-700">
                  <button
                    className={`w-full rounded px-2 py-1 text-left hover:bg-stone-50 ${
                      selectedVersionNo === version.version_no ? "bg-stone-100" : ""
                    }`}
                    onClick={() => void loadVersionSnapshot(version.version_no)}
                    type="button"
                  >
                    v{version.version_no} | {version.change_reason} | {formatDateTime(version.changed_at)}
                  </button>
                </li>
              ))}
            </ul>
            {versionSnapshotLoading ? <p className="mt-2 text-xs text-stone-600">버전 스냅샷 로딩 중...</p> : null}
            {versionSnapshotError ? <p className="mt-2 text-xs text-red-700">{versionSnapshotError}</p> : null}
            {versionSnapshot ? (
              <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-stone-800">
                <p className="font-semibold">
                  v{versionSnapshot.version_no} | {versionSnapshot.change_reason}
                </p>
                <p className="mt-1 text-stone-700">
                  제목: {versionSnapshot.title} | 분류: {versionSnapshot.category || "미분류"} | 이벤트일: {versionSnapshot.event_date || "-"} |
                  변경시각: {formatDateTime(versionSnapshot.changed_at)}
                </p>
                <p className="mt-1 text-stone-700">태그: {versionSnapshot.tags.join(", ") || "-"}</p>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <div className="rounded border border-stone-200 bg-white p-2">
                    <p className="mb-1 font-semibold text-stone-700">설명</p>
                    <RichContentView html={normalizeRichContentHtml(versionSnapshot.description || "-")} className="max-h-36 overflow-auto text-[11px]" />
                  </div>
                  <div className="rounded border border-stone-200 bg-white p-2">
                    <p className="mb-1 font-semibold text-stone-700">요약</p>
                    <RichContentView html={normalizeRichContentHtml(versionSnapshot.summary || "-")} className="max-h-36 overflow-auto text-[11px]" />
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <section className="mt-3 rounded border border-stone-200 p-3">
            <p className="mb-2 text-sm font-semibold text-stone-800">버전 Diff 뷰어</p>
            {detail.versions.length === 0 ? <p className="text-sm text-stone-600">비교할 버전이 없습니다.</p> : null}
            {detail.versions.length > 0 ? (
              <div className="space-y-2">
                <div className="grid gap-2 md:grid-cols-2">
                  <select
                    className="rounded border border-stone-300 px-2 py-1 text-sm"
                    value={diffFromVersionNo}
                    onChange={(e) => setDiffFromVersionNo(Number(e.target.value))}
                  >
                    {detail.versions.map((version) => (
                      <option key={`from-${version.version_no}`} value={version.version_no}>
                        시작 v{version.version_no}
                      </option>
                    ))}
                  </select>
                  <select
                    className="rounded border border-stone-300 px-2 py-1 text-sm"
                    value={diffToVersionNo}
                    onChange={(e) => setDiffToVersionNo(Number(e.target.value))}
                  >
                    {detail.versions.map((version) => (
                      <option key={`to-${version.version_no}`} value={version.version_no}>
                        종료 v{version.version_no}
                      </option>
                    ))}
                  </select>
                </div>
                {diffFromVersionNo > diffToVersionNo ? (
                  <p className="text-xs text-red-700">시작 버전은 종료 버전보다 클 수 없습니다.</p>
                ) : null}
                {diffError ? <p className="text-xs text-red-700">{diffError}</p> : null}
                {diffLoading ? <p className="text-xs text-stone-600">diff 로딩 중...</p> : null}
                {versionDiff ? (
                  <div className="space-y-2">
                    <p className="text-xs text-stone-700">
                      변경 필드: {versionDiff.changed_fields.join(", ") || "(변경 없음)"}
                    </p>
                    <div className="grid gap-2 md:grid-cols-2">
                      <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded border border-stone-200 bg-stone-50 p-2 text-xs text-stone-700">
                        {versionDiff.description_diff}
                      </pre>
                      <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded border border-stone-200 bg-stone-50 p-2 text-xs text-stone-700">
                        {versionDiff.summary_diff}
                      </pre>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        </article>
      ) : null}
    </section>
  );
}

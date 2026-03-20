"use client";

import { DragEvent, FormEvent, useEffect, useRef, useState } from "react";
import { FileText, Paperclip, Pencil, UploadCloud, X } from "lucide-react";
import { apiDelete, apiGet, apiPost, apiPostForm } from "@/lib/api-client";
import { reviewStatusLabel } from "@/lib/labels";

type ReviewStatus = "NONE" | "NEEDS_REVIEW" | "RESOLVED";

type ManualPostResponse = {
  id: string;
  title: string;
  category: string | null;
  event_date: string | null;
  tags: string[];
  file_count?: number;
};

type DocumentDetailLiteResponse = {
  id: string;
  files: { id: string }[];
};

type ManualPostCategoryOptionsResponse = {
  categories: string[];
};

type PostCreateMode = "MERGED" | "SPLIT";

type SplitCreateResult = {
  items: ManualPostResponse[];
  failed_files: { name: string; reason: string }[];
};

const DEFAULT_TAG_TEMPLATE = "";

function parseTags(input: string): string[] {
  return input
    .split(/[,\n]/g)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function buildCaptionTemplate(params: {
  title: string;
  description: string;
  categoryName: string;
  eventDate: string;
  tags: string[];
}): string {
  const lines = [
    params.title.trim() || "제목 입력",
    params.description.trim() || "설명 입력",
    `#분류:${params.categoryName.trim() || "분류명"}`,
    `#날짜:${params.eventDate || "YYYY-MM-DD"}`,
    `#태그:${params.tags.join(",")}`,
  ];
  return lines.join("\n");
}

function validateCaptionTemplate(caption: string): string | null {
  const normalized = caption.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
  if (!/\n?#분류\s*:\s*.+/i.test(normalized)) return "#분류 라인이 필요합니다.";
  if (!/\n?#날짜\s*:\s*.+/i.test(normalized)) return "#날짜 라인이 필요합니다.";
  const tagMatch = normalized.match(/\n?#태그\s*:\s*(.*)/i);
  if (!tagMatch) return "#태그 라인이 필요합니다.";
  return null;
}

function fileFingerprint(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function replaceCaptionTitle(caption: string, nextTitle: string): string {
  const normalized = caption.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length === 0) return nextTitle.trim();
  lines[0] = nextTitle.trim();
  return lines.join("\n");
}

export function ManualPostComposer() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [captionRaw, setCaptionRaw] = useState("");
  const [summary, setSummary] = useState("");
  const [selectedCategoryNames, setSelectedCategoryNames] = useState<string[]>([]);
  const [customCategoryName, setCustomCategoryName] = useState("");
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  const [categoryOptionsLoading, setCategoryOptionsLoading] = useState(true);
  const [categoryOptionsError, setCategoryOptionsError] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [tagsInput, setTagsInput] = useState(DEFAULT_TAG_TEMPLATE);
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>("NONE");
  const [postCreateMode, setPostCreateMode] = useState<PostCreateMode>("MERGED");
  const [useTemplateMode, setUseTemplateMode] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<ManualPostResponse | null>(null);
  const [createdSplit, setCreatedSplit] = useState<SplitCreateResult | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const parsedTags = parseTags(tagsInput);
  const primaryCategoryName = selectedCategoryNames[0] || "";
  const templateCaption = buildCaptionTemplate({
    title,
    description,
    categoryName: primaryCategoryName,
    eventDate,
    tags: parsedTags,
  });

  useEffect(() => {
    let cancelled = false;

    async function loadCategoryOptions() {
      setCategoryOptionsLoading(true);
      setCategoryOptionsError("");
      try {
        const res = await apiGet<ManualPostCategoryOptionsResponse>("/documents/manual-post/category-options");
        if (cancelled) return;
        const names = Array.from(new Set((res.categories ?? []).map((name) => name?.trim()).filter((name): name is string => Boolean(name))));
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

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError("제목은 필수입니다.");
      return;
    }
    if (useTemplateMode) {
      if (selectedCategoryNames.length === 0) {
        setError("템플릿 모드에서는 #분류를 위해 카테고리명을 입력해야 합니다.");
        return;
      }
      if (!eventDate) {
        setError("템플릿 모드에서는 #날짜를 위해 event_date를 입력해야 합니다.");
        return;
      }
    }

    const finalCaption = useTemplateMode ? templateCaption : captionRaw.trim();
    if (!finalCaption) {
      setError("캡션은 비워둘 수 없습니다.");
      return;
    }
    const templateError = validateCaptionTemplate(finalCaption);
    if (templateError) {
      setError(`캡션 템플릿 오류: ${templateError}`);
      return;
    }

    setSubmitting(true);
    setError("");
    setCreated(null);
    setCreatedSplit(null);
    try {
      const baseTitle = title.trim();
      const commonPayload = {
        description,
        summary: summary.trim() || null,
        category_name: primaryCategoryName || null,
        category_names: selectedCategoryNames,
        event_date: eventDate || null,
        tags: parsedTags,
        review_status: reviewStatus,
      };

      if (postCreateMode === "SPLIT") {
        if (selectedFiles.length === 0) {
          setError("분리 모드에서는 첨부파일을 최소 1개 선택해야 합니다.");
          return;
        }

        const successItems: ManualPostResponse[] = [];
        const failedItems: { file: File; reason: string }[] = [];
        for (const file of selectedFiles) {
          const perTitle = selectedFiles.length > 1 ? `${baseTitle} - ${file.name}` : baseTitle;
          const perCaption = useTemplateMode
            ? buildCaptionTemplate({
                title: perTitle,
                description,
                categoryName: primaryCategoryName,
                eventDate,
                tags: parsedTags,
              })
            : replaceCaptionTitle(finalCaption, perTitle);
          try {
            const createdDoc = await apiPost<ManualPostResponse>("/documents/manual-post", {
              ...commonPayload,
              title: perTitle,
              caption_raw: perCaption,
            });

            try {
              const form = new FormData();
              form.append("files", file);
              form.append("change_reason", "manual_post_initial_attach_split");
              const attached = await apiPostForm<DocumentDetailLiteResponse>(`/documents/${createdDoc.id}/files`, form);
              successItems.push({
                ...createdDoc,
                file_count: attached.files.length,
              });
            } catch (attachErr) {
              // Split mode requires 1 file == 1 post. Roll back empty post on attach failure.
              try {
                await apiDelete(`/documents/${createdDoc.id}`);
              } catch {
                // ignore cleanup error
              }
              failedItems.push({
                file,
                reason: attachErr instanceof Error ? attachErr.message : "첨부 업로드 실패",
              });
            }
          } catch (err) {
            failedItems.push({
              file,
              reason: err instanceof Error ? err.message : "게시글 등록 실패",
            });
          }
        }

        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }

        if (successItems.length === 0) {
          setSelectedFiles(failedItems.map((item) => item.file));
          setError(`분리 등록 실패: ${failedItems[0]?.reason ?? "알 수 없는 오류"}`);
          return;
        }

        setCreatedSplit({
          items: successItems,
          failed_files: failedItems.map((item) => ({
            name: item.file.name,
            reason: item.reason,
          })),
        });

        if (failedItems.length > 0) {
          setSelectedFiles(failedItems.map((item) => item.file));
          setError(`분리 등록 부분 실패: 성공 ${successItems.length}건, 실패 ${failedItems.length}건`);
          return;
        }

        setTitle("");
        setDescription("");
        setCaptionRaw("");
        setSummary("");
        setSelectedCategoryNames([]);
        setCustomCategoryName("");
        setEventDate("");
        setTagsInput(DEFAULT_TAG_TEMPLATE);
        setReviewStatus("NONE");
        setUseTemplateMode(true);
        setSelectedFiles([]);
        return;
      }

      const payload = {
        ...commonPayload,
        title: baseTitle,
        caption_raw: finalCaption,
      };
      const res = await apiPost<ManualPostResponse>("/documents/manual-post", payload);
      let totalFiles = 0;
      if (selectedFiles.length > 0) {
        try {
          const form = new FormData();
          for (const file of selectedFiles) {
            form.append("files", file);
          }
          form.append("change_reason", "manual_post_initial_attach");
          const attached = await apiPostForm<DocumentDetailLiteResponse>(`/documents/${res.id}/files`, form);
          totalFiles = attached.files.length;
        } catch (attachErr) {
          setCreated({
            ...res,
            file_count: 0,
          });
          setError(
            attachErr instanceof Error
              ? `게시글은 등록되었지만 첨부 업로드 실패: ${attachErr.message}`
              : "게시글은 등록되었지만 첨부 업로드 실패",
          );
          return;
        }
      }

      setCreated({
        ...res,
        file_count: totalFiles,
      });
      setTitle("");
      setDescription("");
      setCaptionRaw("");
      setSummary("");
      setSelectedCategoryNames([]);
      setCustomCategoryName("");
      setEventDate("");
      setTagsInput(DEFAULT_TAG_TEMPLATE);
      setReviewStatus("NONE");
      setUseTemplateMode(true);
      setSelectedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "수동 게시글 등록 실패");
    } finally {
      setSubmitting(false);
    }
  };

  const addFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    setSelectedFiles((prev) => {
      const seen = new Set(prev.map(fileFingerprint));
      const merged = [...prev];
      for (const file of incoming) {
        const key = fileFingerprint(file);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(file);
      }
      return merged;
    });
  };

  const removeFile = (target: File) => {
    const targetKey = fileFingerprint(target);
    setSelectedFiles((prev) => prev.filter((file) => fileFingerprint(file) !== targetKey));
  };

  const onDropFiles = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const dropped = Array.from(e.dataTransfer.files ?? []);
    addFiles(dropped);
  };

  const toggleCategorySelection = (categoryName: string) => {
    const normalized = categoryName.trim();
    if (!normalized) return;
    setSelectedCategoryNames((prev) => {
      if (prev.includes(normalized)) {
        return prev.filter((name) => name !== normalized);
      }
      return [...prev, normalized];
    });
  };

  const addCustomCategorySelection = () => {
    const normalized = customCategoryName.trim();
    if (!normalized) return;
    setSelectedCategoryNames((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
    setCustomCategoryName("");
  };

  const removeSelectedCategory = (categoryName: string) => {
    setSelectedCategoryNames((prev) => prev.filter((name) => name !== categoryName));
  };

  return (
    <article className="rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
      <p className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-stone-700">
        <FileText className="h-4 w-4 text-accent" />
        수동 게시 입력
      </p>
      <form className="grid gap-3 md:grid-cols-2" onSubmit={onSubmit}>
        <label className="grid gap-1 text-sm md:col-span-2">
          <span className="text-xs font-semibold text-stone-600">제목 *</span>
          <input className="rounded border border-stone-300 px-3 py-2" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>

        <label className="grid gap-1 text-sm md:col-span-2">
          <span className="text-xs font-semibold text-stone-600">설명</span>
          <textarea
            className="min-h-24 rounded border border-stone-300 px-3 py-2"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <label className="grid gap-1 text-sm md:col-span-2">
          <span className="text-xs font-semibold text-stone-600">원본 캡션(선택)</span>
          <div className="rounded border border-stone-200 bg-stone-50 p-2">
            <label className="mb-2 flex items-center gap-2 text-xs text-stone-700">
              <input type="checkbox" checked={useTemplateMode} onChange={(e) => setUseTemplateMode(e.target.checked)} />
              템플릿 고정 모드(권장)
            </label>
            {useTemplateMode ? (
              <textarea className="min-h-24 w-full rounded border border-stone-300 px-3 py-2 text-xs" value={templateCaption} readOnly />
            ) : (
              <textarea
                className="min-h-24 w-full rounded border border-stone-300 px-3 py-2 text-xs"
                placeholder={"직접 입력 시에도 #분류/#날짜/#태그 라인 필요"}
                value={captionRaw}
                onChange={(e) => setCaptionRaw(e.target.value)}
              />
            )}
          </div>
        </label>

        <label className="grid gap-1 text-sm">
          <span className="text-xs font-semibold text-stone-600">요약(선택)</span>
          <input className="rounded border border-stone-300 px-3 py-2" value={summary} onChange={(e) => setSummary(e.target.value)} />
        </label>

        <label className="grid gap-1 text-sm">
          <span className="text-xs font-semibold text-stone-600">카테고리(복수 선택 가능)</span>
          <div className="space-y-2 rounded border border-stone-200 p-2">
            <div className="grid max-h-24 grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-2 gap-y-1 overflow-auto rounded border border-stone-200 bg-white p-2">
              {categoryOptions.map((name) => (
                <label key={name} className="flex min-w-0 items-center gap-2 text-xs text-stone-700">
                  <input type="checkbox" checked={selectedCategoryNames.includes(name)} onChange={() => toggleCategorySelection(name)} />
                  <span className="truncate">{name}</span>
                </label>
              ))}
              {categoryOptions.length === 0 ? <p className="text-xs text-stone-500">등록된 카테고리가 없습니다.</p> : null}
            </div>
            <div className="flex items-center gap-2">
              <input
                className="rounded border border-stone-300 px-3 py-2"
                placeholder="신규 카테고리명"
                value={customCategoryName}
                onChange={(e) => setCustomCategoryName(e.target.value)}
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
              {selectedCategoryNames.length === 0 ? <span className="text-[11px] text-stone-500">선택된 카테고리 없음</span> : null}
              {selectedCategoryNames.map((name, idx) => (
                <button
                  key={name}
                  type="button"
                  className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] ${idx === 0 ? "border-accent bg-accent/10 text-accent" : "border-stone-300 bg-white text-stone-700"}`}
                  title={idx === 0 ? "기본 카테고리" : "보조 카테고리"}
                  onClick={() => removeSelectedCategory(name)}
                >
                  <span>{name}</span>
                  <span>×</span>
                </button>
              ))}
            </div>
          </div>
          {categoryOptionsLoading ? <p className="text-[11px] text-stone-500">카테고리 목록 로딩 중...</p> : null}
          {categoryOptionsError ? <p className="text-[11px] text-amber-700">목록 로드 실패: {categoryOptionsError}</p> : null}
        </label>

        <label className="grid gap-1 text-sm">
          <span className="text-xs font-semibold text-stone-600">문서 시점(event_date)</span>
          <input className="rounded border border-stone-300 px-3 py-2" type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
        </label>

        <label className="grid gap-1 text-sm">
          <span className="text-xs font-semibold text-stone-600">검토 상태(review_status)</span>
          <select
            className="rounded border border-stone-300 px-2 py-2"
            value={reviewStatus}
            onChange={(e) => setReviewStatus(e.target.value as ReviewStatus)}
          >
            <option value="NONE">{reviewStatusLabel("NONE")}</option>
            <option value="NEEDS_REVIEW">{reviewStatusLabel("NEEDS_REVIEW")}</option>
            <option value="RESOLVED">{reviewStatusLabel("RESOLVED")}</option>
          </select>
        </label>

        <label className="grid gap-1 text-sm md:col-span-2">
          <span className="text-xs font-semibold text-stone-600">태그(쉼표/줄바꿈 구분)</span>
          <textarea
            className="min-h-20 rounded border border-stone-300 px-3 py-2"
            placeholder="예: 프로젝트A,회의록,중요"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
          />
          <p className="text-xs text-stone-500">원하는 태그만 입력하면 됩니다. 쉼표 또는 줄바꿈으로 구분합니다.</p>
        </label>

        <div className="grid gap-2 text-sm md:col-span-2">
          <span className="text-xs font-semibold text-stone-600">첨부파일(다중, 드래그 앤 드롭)</span>
          <div
            className={`rounded-lg border-2 border-dashed p-4 text-sm ${
              dragActive ? "border-accent bg-accent/10" : "border-stone-300 bg-stone-50"
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragActive(false);
            }}
            onDrop={onDropFiles}
          >
            <div className="flex flex-wrap items-center gap-2">
              <UploadCloud className="h-4 w-4 text-accent" />
              <span>파일을 여기에 드래그하세요.</span>
              <button
                className="rounded border border-stone-300 bg-white px-2 py-1 text-xs hover:bg-stone-100"
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                파일 선택
              </button>
              <input
                ref={fileInputRef}
                className="hidden"
                type="file"
                multiple
                onChange={(e) => addFiles(Array.from(e.target.files ?? []))}
              />
            </div>

            {selectedFiles.length > 0 ? (
              <ul className="mt-3 space-y-1">
                {selectedFiles.map((file) => (
                  <li key={fileFingerprint(file)} className="flex items-center justify-between rounded border border-stone-200 bg-white px-2 py-1 text-xs">
                    <span className="inline-flex items-center gap-1 truncate pr-2">
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-stone-500" />
                      {file.name}
                    </span>
                    <button
                      className="rounded border border-red-200 px-1.5 py-0.5 text-[11px] text-red-700 hover:bg-red-50"
                      type="button"
                      onClick={() => removeFile(file)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-stone-500">선택된 파일 없음</p>
            )}
          </div>
        </div>

        <label className="grid gap-1 text-sm md:col-span-2">
          <span className="text-xs font-semibold text-stone-600">게시물 생성 방식</span>
          <div className="grid gap-2 rounded border border-stone-200 bg-stone-50 p-3 text-xs">
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="post-create-mode"
                value="MERGED"
                checked={postCreateMode === "MERGED"}
                onChange={() => setPostCreateMode("MERGED")}
              />
              통합 게시: 게시물 1개 + 첨부파일 여러 개
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="post-create-mode"
                value="SPLIT"
                checked={postCreateMode === "SPLIT"}
                onChange={() => setPostCreateMode("SPLIT")}
              />
              분리 게시: 파일 1개당 게시물 1개
            </label>
          </div>
          <p className="text-xs text-stone-500">분리 모드에서는 제목이 &quot;기본제목 - 파일명&quot; 형태로 자동 생성됩니다.</p>
        </label>

        <div className="md:col-span-2">
          <button type="submit" className="inline-flex items-center gap-1 rounded bg-accent px-4 py-2 text-sm text-white disabled:opacity-60" disabled={submitting}>
            <Pencil className="h-4 w-4" />
            {submitting ? "등록 중..." : "수동 게시글 등록"}
          </button>
        </div>
      </form>

      {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
      {created ? (
        <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <p className="font-medium">등록 완료: {created.title}</p>
          <p>ID: {created.id}</p>
          <p>첨부파일: {created.file_count ?? 0}개</p>
          <a className="mt-1 inline-block underline" href={`/documents/${created.id}`}>
            상세 페이지로 이동
          </a>
        </div>
      ) : null}
      {createdSplit ? (
        <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <p className="font-medium">분리 등록 완료: 성공 {createdSplit.items.length}건</p>
          {createdSplit.failed_files.length > 0 ? <p className="text-xs text-amber-700">실패 {createdSplit.failed_files.length}건</p> : null}
          <ul className="mt-2 space-y-1 text-xs">
            {createdSplit.items.slice(0, 10).map((item) => (
              <li key={item.id}>
                <a className="underline" href={`/documents/${item.id}`}>
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
          {createdSplit.items.length > 10 ? <p className="mt-1 text-xs">외 {createdSplit.items.length - 10}건 더 등록됨</p> : null}
          {createdSplit.failed_files.length > 0 ? (
            <p className="mt-1 text-xs text-red-700">
              실패 파일:{" "}
              {createdSplit.failed_files
                .slice(0, 5)
                .map((item) => item.name)
                .join(", ")}
              {createdSplit.failed_files.length > 5 ? " ..." : ""}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Files,
  History,
  RefreshCcw,
} from "lucide-react";
import { apiFetch, apiGet, apiPost, buildApiUrl } from "@/lib/api-client";

type SourceType = "wiki" | "manual" | "api";
type IngestState =
  | "RECEIVED"
  | "STORED"
  | "EXTRACTED"
  | "CLASSIFIED"
  | "INDEXED"
  | "PUBLISHED"
  | "FAILED"
  | "NEEDS_REVIEW";

type AuditLogItem = {
  id: number;
  created_at: string;
  actor_user_id: string | null;
  actor_username: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  source: SourceType | null;
  source_ref: string | null;
  masked_fields: string[];
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
};

type AuditLogsResponse = {
  items: AuditLogItem[];
  page: number;
  size: number;
  total: number;
};

type IngestJobItem = {
  id: string;
  source: SourceType;
  source_ref: string | null;
  state: IngestState;
  document_id: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
  retry_after: string | null;
  received_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type IngestJobsResponse = {
  items: IngestJobItem[];
  page: number;
  size: number;
  total: number;
};

type IngestEventItem = {
  id: number;
  ingest_job_id: string;
  from_state: IngestState | null;
  to_state: IngestState;
  event_type: string;
  event_message: string;
  event_payload: Record<string, unknown>;
  occurred_at: string;
};

type IngestEventsResponse = {
  ingest_job_id: string;
  items: IngestEventItem[];
};

type RequeueIngestJobResponse = {
  job_id: string;
  previous_state: IngestState;
  state: IngestState;
  enqueued: boolean;
  queued_at: string;
};

type RecoverIngestJobUploadResponse = {
  job_id: string;
  previous_state: IngestState;
  state: IngestState;
  enqueued: boolean;
  queued_at: string;
  uploaded_filename: string;
  uploaded_size_bytes: number;
};

type OpsReportItem = {
  id: number;
  created_at: string;
  period_start: string;
  period_end: string;
  ingest_total: number;
  failed_jobs: number;
  failure_rate_pct: number;
  classified_docs: number;
  auto_classified_docs: number;
  classification_accuracy_pct: number;
  needs_review_open: number;
  review_resolution_count: number;
  review_queue_avg_resolution_hours: number | null;
};

type OpsReportsResponse = {
  items: OpsReportItem[];
  page: number;
  size: number;
  total: number;
};

type OpsReportGenerateResponse = {
  task_id: string;
  status: string;
};

const PAGE_SIZE = 20;
const SOURCE_OPTIONS: Array<SourceType | ""> = ["", "manual", "api", "wiki"];
const INGEST_STATES: Array<IngestState | ""> = [
  "",
  "RECEIVED",
  "STORED",
  "EXTRACTED",
  "CLASSIFIED",
  "INDEXED",
  "PUBLISHED",
  "FAILED",
  "NEEDS_REVIEW",
];

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? "-" : dt.toLocaleString("ko-KR");
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "-";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function AdminLogViewer() {
  const [auditItems, setAuditItems] = useState<AuditLogItem[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditAction, setAuditAction] = useState("");
  const [auditTargetType, setAuditTargetType] = useState("");
  const [auditTargetId, setAuditTargetId] = useState("");
  const [auditSourceRef, setAuditSourceRef] = useState("");
  const [auditKeyword, setAuditKeyword] = useState("");
  const [auditSource, setAuditSource] = useState<SourceType | "">("");
  const [auditIncludePayload, setAuditIncludePayload] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [selectedAuditId, setSelectedAuditId] = useState<number | null>(null);
  const [exportingAudit, setExportingAudit] = useState(false);

  const [jobs, setJobs] = useState<IngestJobItem[]>([]);
  const [jobsTotal, setJobsTotal] = useState(0);
  const [jobsPage, setJobsPage] = useState(1);
  const [jobState, setJobState] = useState<IngestState | "">("");
  const [jobSource, setJobSource] = useState<SourceType | "">("");
  const [jobSourceRef, setJobSourceRef] = useState("");
  const [jobsLoading, setJobsLoading] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const [events, setEvents] = useState<IngestEventItem[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [requeueForce, setRequeueForce] = useState(false);
  const [requeueResetAttempts, setRequeueResetAttempts] = useState(false);
  const [requeueBusy, setRequeueBusy] = useState(false);
  const [recoverFile, setRecoverFile] = useState<File | null>(null);
  const [recoverCaption, setRecoverCaption] = useState("");
  const [recoverResetAttempts, setRecoverResetAttempts] = useState(false);
  const [recoverClearError, setRecoverClearError] = useState(true);
  const [recoverBusy, setRecoverBusy] = useState(false);
  const [recoverInputKey, setRecoverInputKey] = useState(0);

  const [opsReports, setOpsReports] = useState<OpsReportItem[]>([]);
  const [opsReportsLoading, setOpsReportsLoading] = useState(false);
  const [opsReportGenerateBusy, setOpsReportGenerateBusy] = useState(false);

  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const selectedAudit = useMemo(
    () => auditItems.find((item) => item.id === selectedAuditId) ?? null,
    [auditItems, selectedAuditId],
  );
  const selectedJob = useMemo(
    () => jobs.find((item) => item.id === selectedJobId) ?? null,
    [jobs, selectedJobId],
  );

  const loadAuditLogs = useCallback(async () => {
    setAuditLoading(true);
    setError("");
    setMessage("");
    try {
      const params = new URLSearchParams();
      params.set("page", String(auditPage));
      params.set("size", String(PAGE_SIZE));
      params.set("include_payload", String(auditIncludePayload));
      if (auditAction.trim()) params.set("action", auditAction.trim());
      if (auditTargetType.trim()) params.set("target_type", auditTargetType.trim());
      if (auditTargetId.trim()) params.set("target_id", auditTargetId.trim());
      if (auditSourceRef.trim()) params.set("source_ref", auditSourceRef.trim());
      if (auditKeyword.trim()) params.set("q", auditKeyword.trim());
      if (auditSource) params.set("source", auditSource);

      const res = await apiGet<AuditLogsResponse>(`/admin/audit-logs?${params.toString()}`);
      setAuditItems(res.items);
      setAuditTotal(res.total);
      setSelectedAuditId((prev) => {
        if (prev && res.items.some((x) => x.id === prev)) return prev;
        return res.items[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "audit log 로드 실패");
      setAuditItems([]);
      setAuditTotal(0);
      setSelectedAuditId(null);
    } finally {
      setAuditLoading(false);
    }
  }, [auditAction, auditIncludePayload, auditKeyword, auditPage, auditSource, auditSourceRef, auditTargetId, auditTargetType]);

  const loadIngestJobs = useCallback(async () => {
    setJobsLoading(true);
    setError("");
    setMessage("");
    try {
      const params = new URLSearchParams();
      params.set("page", String(jobsPage));
      params.set("size", String(PAGE_SIZE));
      if (jobState) params.set("state", jobState);
      if (jobSource) params.set("source", jobSource);
      if (jobSourceRef.trim()) params.set("source_ref", jobSourceRef.trim());

      const res = await apiGet<IngestJobsResponse>(`/admin/ingest-jobs?${params.toString()}`);
      setJobs(res.items);
      setJobsTotal(res.total);
      setSelectedJobId((prev) => {
        if (prev && res.items.some((x) => x.id === prev)) return prev;
        return res.items[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "ingest jobs 로드 실패");
      setJobs([]);
      setJobsTotal(0);
      setSelectedJobId(null);
    } finally {
      setJobsLoading(false);
    }
  }, [jobSource, jobSourceRef, jobState, jobsPage]);

  const loadEvents = useCallback(async () => {
    if (!selectedJobId) {
      setEvents([]);
      return;
    }

    setEventsLoading(true);
    setError("");
    setMessage("");
    try {
      const res = await apiGet<IngestEventsResponse>(`/admin/ingest-jobs/${selectedJobId}/events?limit=100`);
      setEvents(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ingest events 로드 실패");
      setEvents([]);
    } finally {
      setEventsLoading(false);
    }
  }, [selectedJobId]);

  const loadOpsReports = useCallback(async () => {
    setOpsReportsLoading(true);
    setError("");
    try {
      const res = await apiGet<OpsReportsResponse>("/admin/ops-reports?page=1&size=20");
      setOpsReports(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "운영 리포트 로드 실패");
      setOpsReports([]);
    } finally {
      setOpsReportsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAuditLogs();
  }, [loadAuditLogs]);

  useEffect(() => {
    void loadIngestJobs();
  }, [loadIngestJobs]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    void loadOpsReports();
  }, [loadOpsReports]);

  const requeueSelectedJob = async () => {
    if (!selectedJobId) {
      setError("재처리할 job을 선택하세요.");
      return;
    }

    setRequeueBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiPost<RequeueIngestJobResponse>(
        `/admin/ingest-jobs/${selectedJobId}/requeue`,
        {
          force: requeueForce,
          reset_attempts: requeueResetAttempts,
          clear_error: true,
        },
      );
      setMessage(
        `재처리 큐 등록 완료: ${result.job_id} (${result.previous_state} -> ${result.state})`,
      );
      await loadIngestJobs();
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "재처리 요청 실패");
    } finally {
      setRequeueBusy(false);
    }
  };

  const recoverSelectedJobWithUpload = async () => {
    if (!selectedJobId) {
      setError("복구할 job을 선택하세요.");
      return;
    }
    if (!recoverFile) {
      setError("복구용 파일을 선택하세요.");
      return;
    }

    setRecoverBusy(true);
    setError("");
    setMessage("");
    try {
      const form = new FormData();
      form.append("file", recoverFile);
      if (recoverCaption.trim()) form.append("caption", recoverCaption.trim());
      form.append("reset_attempts", String(recoverResetAttempts));
      form.append("clear_error", String(recoverClearError));

      const result = await apiFetch<RecoverIngestJobUploadResponse>(
        `/admin/ingest-jobs/${selectedJobId}/recover-upload`,
        { method: "POST", body: form },
      );
      setMessage(
        `파일 복구 재처리 완료: ${result.uploaded_filename} (${result.uploaded_size_bytes} bytes)`,
      );
      setRecoverFile(null);
      setRecoverCaption("");
      setRecoverInputKey((prev) => prev + 1);
      await loadIngestJobs();
      await loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "파일 복구 재처리 실패");
    } finally {
      setRecoverBusy(false);
    }
  };

  const exportAuditLogs = async (fmt: "csv" | "json") => {
    setExportingAudit(true);
    setError("");
    setMessage("");
    try {
      const params = new URLSearchParams();
      params.set("fmt", fmt);
      params.set("include_payload", String(auditIncludePayload));
      if (auditAction.trim()) params.set("action", auditAction.trim());
      if (auditTargetType.trim()) params.set("target_type", auditTargetType.trim());
      if (auditTargetId.trim()) params.set("target_id", auditTargetId.trim());
      if (auditSourceRef.trim()) params.set("source_ref", auditSourceRef.trim());
      if (auditKeyword.trim()) params.set("q", auditKeyword.trim());
      if (auditSource) params.set("source", auditSource);

      const response = await fetch(buildApiUrl(`/admin/audit-logs/export?${params.toString()}`), {
        method: "GET",
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit_logs.${fmt}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setMessage(`감사 로그 ${fmt.toUpperCase()} export 완료`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "감사 로그 export 실패");
    } finally {
      setExportingAudit(false);
    }
  };

  const generateOpsReport = async () => {
    setOpsReportGenerateBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiPost<OpsReportGenerateResponse>("/admin/ops-reports/generate?days=7", {});
      setMessage(`주간 운영 리포트 생성 요청 완료: task=${result.task_id}`);
      await loadOpsReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : "운영 리포트 생성 요청 실패");
    } finally {
      setOpsReportGenerateBusy(false);
    }
  };

  const auditTotalPages = Math.max(1, Math.ceil(auditTotal / PAGE_SIZE));
  const jobsTotalPages = Math.max(1, Math.ceil(jobsTotal / PAGE_SIZE));

  return (
    <section className="space-y-4">
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}

      <article className="rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="inline-flex items-center gap-1 text-sm font-semibold">
            <History className="h-4 w-4 text-accent" />
            주간 운영 리포트
          </h2>
          <div className="flex gap-1">
            <button
              className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50 disabled:opacity-50"
              onClick={() => void generateOpsReport()}
              disabled={opsReportGenerateBusy}
            >
              <Files className="h-3.5 w-3.5" />
              주간 리포트 생성
            </button>
            <button
              className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50 disabled:opacity-50"
              onClick={() => void loadOpsReports()}
              disabled={opsReportsLoading}
            >
              <RefreshCcw className="h-3.5 w-3.5" />
              새로고침
            </button>
          </div>
        </div>
        {opsReportsLoading ? <p className="text-sm text-stone-600">리포트 로딩 중...</p> : null}
        {!opsReportsLoading ? (
          <div className="overflow-x-auto rounded border border-stone-200">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-stone-500">
                  <th className="py-2 pl-3">생성시각</th>
                  <th className="py-2">기간</th>
                  <th className="py-2">실패율</th>
                  <th className="py-2">분류정확도</th>
                  <th className="py-2 pr-3">검토체류(avg h)</th>
                </tr>
              </thead>
              <tbody>
                {opsReports.length === 0 ? (
                  <tr>
                    <td className="py-3 pl-3 text-stone-600" colSpan={5}>
                      리포트 없음
                    </td>
                  </tr>
                ) : null}
                {opsReports.map((report) => (
                  <tr key={report.id} className="border-b border-stone-100">
                    <td className="py-2 pl-3">{formatDateTime(report.created_at)}</td>
                    <td className="py-2">
                      {formatDateTime(report.period_start)} ~ {formatDateTime(report.period_end)}
                    </td>
                    <td className="py-2">
                      {report.failure_rate_pct}% ({report.failed_jobs}/{report.ingest_total})
                    </td>
                    <td className="py-2">
                      {report.classification_accuracy_pct}% ({report.auto_classified_docs}/{report.classified_docs})
                    </td>
                    <td className="py-2 pr-3">{report.review_queue_avg_resolution_hours ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </article>

      <article className="rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="inline-flex items-center gap-1 text-sm font-semibold">
            <FileText className="h-4 w-4 text-accent" />
            감사 로그
          </h2>
          <div className="flex gap-1">
            <button
              className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50 disabled:opacity-50"
              onClick={() => void exportAuditLogs("csv")}
              disabled={exportingAudit}
            >
              CSV Export
            </button>
            <button
              className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50 disabled:opacity-50"
              onClick={() => void exportAuditLogs("json")}
              disabled={exportingAudit}
            >
              JSON Export
            </button>
            <button className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50" onClick={() => void loadAuditLogs()}>
              <RefreshCcw className="h-3.5 w-3.5" />
              새로고침
            </button>
          </div>
        </div>
        <div className="mb-3 grid gap-2 md:grid-cols-4">
          <input
            className="rounded border border-stone-300 px-2 py-1 text-sm"
            placeholder="action"
            value={auditAction}
            onChange={(e) => {
              setAuditAction(e.target.value);
              setAuditPage(1);
            }}
          />
          <input
            className="rounded border border-stone-300 px-2 py-1 text-sm"
            placeholder="target_type"
            value={auditTargetType}
            onChange={(e) => {
              setAuditTargetType(e.target.value);
              setAuditPage(1);
            }}
          />
          <input
            className="rounded border border-stone-300 px-2 py-1 text-sm"
            placeholder="target_id(uuid)"
            value={auditTargetId}
            onChange={(e) => {
              setAuditTargetId(e.target.value);
              setAuditPage(1);
            }}
          />
          <input
            className="rounded border border-stone-300 px-2 py-1 text-sm"
            placeholder="source_ref"
            value={auditSourceRef}
            onChange={(e) => {
              setAuditSourceRef(e.target.value);
              setAuditPage(1);
            }}
          />
          <input
            className="rounded border border-stone-300 px-2 py-1 text-sm"
            placeholder="keyword(q)"
            value={auditKeyword}
            onChange={(e) => {
              setAuditKeyword(e.target.value);
              setAuditPage(1);
            }}
          />
          <select
            className="rounded border border-stone-300 px-2 py-1 text-sm"
            value={auditSource}
            onChange={(e) => {
              setAuditSource((e.target.value as SourceType | "") || "");
              setAuditPage(1);
            }}
          >
            {SOURCE_OPTIONS.map((source) => (
              <option key={source || "all"} value={source}>
                {source || "source 전체"}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs text-stone-700">
            <input
              type="checkbox"
              checked={auditIncludePayload}
              onChange={(e) => {
                setAuditIncludePayload(e.target.checked);
                setAuditPage(1);
              }}
            />
            payload 포함
          </label>
        </div>

        <div className="overflow-x-auto rounded border border-stone-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-stone-500">
                <th className="py-2 pl-3">시간</th>
                <th className="py-2">Action</th>
                <th className="py-2">Target</th>
                <th className="py-2">Actor</th>
                <th className="py-2 pr-3">Source</th>
              </tr>
            </thead>
            <tbody>
              {auditLoading ? (
                <tr>
                  <td className="py-3 pl-3 text-stone-600" colSpan={5}>
                    로딩 중...
                  </td>
                </tr>
              ) : null}
              {!auditLoading && auditItems.length === 0 ? (
                <tr>
                  <td className="py-3 pl-3 text-stone-600" colSpan={5}>
                    로그 없음
                  </td>
                </tr>
              ) : null}
              {auditItems.map((item) => (
                <tr
                  key={item.id}
                  className={`cursor-pointer border-b border-stone-100 ${
                    selectedAuditId === item.id ? "bg-stone-50" : ""
                  }`}
                  onClick={() => setSelectedAuditId(item.id)}
                >
                  <td className="py-2 pl-3">{formatDateTime(item.created_at)}</td>
                  <td className="py-2">{item.action}</td>
                  <td className="py-2">
                    {item.target_type}
                    {item.target_id ? `:${item.target_id.slice(0, 8)}` : ""}
                  </td>
                  <td className="py-2">{item.actor_username ?? "-"}</td>
                  <td className="py-2 pr-3">{item.source ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-2 flex items-center justify-between">
          <p className="text-xs text-stone-600">
            총 {auditTotal.toLocaleString("ko-KR")}건 | 페이지 {auditPage}/{auditTotalPages}
          </p>
          <div className="flex gap-1">
            <button
              className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs disabled:opacity-50"
              onClick={() => setAuditPage((prev) => Math.max(1, prev - 1))}
              disabled={auditPage <= 1}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              이전
            </button>
            <button
              className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs disabled:opacity-50"
              onClick={() => setAuditPage((prev) => Math.min(auditTotalPages, prev + 1))}
              disabled={auditPage >= auditTotalPages}
            >
              다음
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="mt-3 rounded border border-stone-200 bg-stone-50 p-2">
          <p className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-stone-700">
            <FileText className="h-3.5 w-3.5 text-accent" />
            선택 로그 상세
          </p>
          {!selectedAudit ? <p className="text-xs text-stone-600">선택된 로그가 없습니다.</p> : null}
          {selectedAudit ? (
            <div className="grid gap-2 md:grid-cols-2">
              <pre className="overflow-auto rounded border border-stone-200 bg-white p-2 text-xs">
                before_json:
                {"\n"}
                {formatJson(selectedAudit.before_json)}
              </pre>
              <pre className="overflow-auto rounded border border-stone-200 bg-white p-2 text-xs">
                after_json:
                {"\n"}
                {formatJson(selectedAudit.after_json)}
              </pre>
            </div>
          ) : null}
        </div>
      </article>

      <article className="rounded-lg border border-stone-200 bg-panel p-4 shadow-panel">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="inline-flex items-center gap-1 text-sm font-semibold">
            <Files className="h-4 w-4 text-accent" />
            운영 로그 (Ingest Jobs)
          </h2>
          <button className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50" onClick={() => void loadIngestJobs()}>
            <RefreshCcw className="h-3.5 w-3.5" />
            새로고침
          </button>
        </div>

        <div className="mb-3 grid gap-2 md:grid-cols-3">
          <select
            className="rounded border border-stone-300 px-2 py-1 text-sm"
            value={jobState}
            onChange={(e) => {
              setJobState((e.target.value as IngestState | "") || "");
              setJobsPage(1);
            }}
          >
            {INGEST_STATES.map((state) => (
              <option key={state || "all"} value={state}>
                {state || "state 전체"}
              </option>
            ))}
          </select>
          <select
            className="rounded border border-stone-300 px-2 py-1 text-sm"
            value={jobSource}
            onChange={(e) => {
              setJobSource((e.target.value as SourceType | "") || "");
              setJobsPage(1);
            }}
          >
            {SOURCE_OPTIONS.map((source) => (
              <option key={source || "all"} value={source}>
                {source || "source 전체"}
              </option>
            ))}
          </select>
          <input
            className="rounded border border-stone-300 px-2 py-1 text-sm"
            placeholder="source_ref 검색"
            value={jobSourceRef}
            onChange={(e) => {
              setJobSourceRef(e.target.value);
              setJobsPage(1);
            }}
          />
        </div>

        <div className="overflow-x-auto rounded border border-stone-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-stone-500">
                <th className="py-2 pl-3">received</th>
                <th className="py-2">state</th>
                <th className="py-2">source</th>
                <th className="py-2">attempt</th>
                <th className="py-2">retry_after</th>
                <th className="py-2 pr-3">error</th>
              </tr>
            </thead>
            <tbody>
              {jobsLoading ? (
                <tr>
                  <td className="py-3 pl-3 text-stone-600" colSpan={6}>
                    로딩 중...
                  </td>
                </tr>
              ) : null}
              {!jobsLoading && jobs.length === 0 ? (
                <tr>
                  <td className="py-3 pl-3 text-stone-600" colSpan={6}>
                    ingest job 없음
                  </td>
                </tr>
              ) : null}
              {jobs.map((job) => (
                <tr
                  key={job.id}
                  className={`cursor-pointer border-b border-stone-100 ${selectedJobId === job.id ? "bg-stone-50" : ""}`}
                  onClick={() => setSelectedJobId(job.id)}
                >
                  <td className="py-2 pl-3">{formatDateTime(job.received_at)}</td>
                  <td className="py-2">{job.state}</td>
                  <td className="py-2">
                    {job.source}
                    {job.source_ref ? `:${job.source_ref}` : ""}
                  </td>
                  <td className="py-2">
                    {job.attempt_count}/{job.max_attempts}
                  </td>
                  <td className="py-2">{formatDateTime(job.retry_after)}</td>
                  <td className="py-2 pr-3">{job.last_error_code ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-2 flex items-center justify-between">
          <p className="text-xs text-stone-600">
            총 {jobsTotal.toLocaleString("ko-KR")}건 | 페이지 {jobsPage}/{jobsTotalPages}
          </p>
          <div className="flex gap-1">
            <button
              className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs disabled:opacity-50"
              onClick={() => setJobsPage((prev) => Math.max(1, prev - 1))}
              disabled={jobsPage <= 1}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              이전
            </button>
            <button
              className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs disabled:opacity-50"
              onClick={() => setJobsPage((prev) => Math.min(jobsTotalPages, prev + 1))}
              disabled={jobsPage >= jobsTotalPages}
            >
              다음
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="mt-3 rounded border border-stone-200 bg-stone-50 p-2">
          <div className="mb-1 flex items-center justify-between">
            <p className="inline-flex items-center gap-1 text-xs font-semibold text-stone-700">
              <History className="h-3.5 w-3.5 text-accent" />
              선택 Job 이벤트
            </p>
            <button
              className="inline-flex items-center gap-1 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-50 disabled:opacity-50"
              onClick={() => void loadEvents()}
              disabled={!selectedJobId || eventsLoading}
            >
              <RefreshCcw className="h-3.5 w-3.5" />
              이벤트 새로고침
            </button>
          </div>

          <div className="mb-2 rounded border border-stone-200 bg-white p-2 text-xs">
            {!selectedJob ? <p className="text-stone-600">선택된 job 없음</p> : null}
            {selectedJob ? (
              <div className="space-y-1">
                <p>
                  job_id: <span className="font-medium">{selectedJob.id}</span>
                </p>
                <p>state: {selectedJob.state}</p>
                <p>document_id: {selectedJob.document_id ?? "-"}</p>
                <p>last_error_code: {selectedJob.last_error_code ?? "-"}</p>
                <p>last_error_message: {selectedJob.last_error_message ?? "-"}</p>
                <p>retry_after: {formatDateTime(selectedJob.retry_after)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={requeueForce}
                      onChange={(e) => setRequeueForce(e.target.checked)}
                    />
                    force
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={requeueResetAttempts}
                      onChange={(e) => setRequeueResetAttempts(e.target.checked)}
                    />
                    attempt 초기화
                  </label>
                  <button
                    className="rounded border border-stone-300 px-2 py-1 hover:bg-stone-50 disabled:opacity-50"
                    onClick={() => void requeueSelectedJob()}
                    disabled={!selectedJobId || requeueBusy}
                  >
                    {requeueBusy ? "재처리 요청 중..." : "재처리 큐잉"}
                  </button>
                </div>

                <div className="mt-2 space-y-1 rounded border border-stone-200 bg-stone-50 p-2">
                  <p className="font-medium text-stone-700">파일 복구 재처리</p>
                  <input
                    key={recoverInputKey}
                    type="file"
                    className="w-full rounded border border-stone-300 px-2 py-1"
                    onChange={(e) => setRecoverFile(e.target.files?.[0] ?? null)}
                  />
                  <textarea
                    className="h-16 w-full rounded border border-stone-300 p-2"
                    placeholder="caption override (optional)"
                    value={recoverCaption}
                    onChange={(e) => setRecoverCaption(e.target.value)}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={recoverResetAttempts}
                        onChange={(e) => setRecoverResetAttempts(e.target.checked)}
                      />
                      attempt 초기화
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={recoverClearError}
                        onChange={(e) => setRecoverClearError(e.target.checked)}
                      />
                      오류 지우기
                    </label>
                    <button
                      className="rounded border border-stone-300 px-2 py-1 hover:bg-stone-50 disabled:opacity-50"
                      onClick={() => void recoverSelectedJobWithUpload()}
                      disabled={!selectedJobId || !recoverFile || recoverBusy}
                    >
                      {recoverBusy ? "업로드/재처리 중..." : "파일 업로드 후 재처리"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {eventsLoading ? <p className="text-xs text-stone-600">이벤트 로딩 중...</p> : null}
          {!eventsLoading && events.length === 0 ? <p className="text-xs text-stone-600">이벤트 없음</p> : null}
          {!eventsLoading && events.length > 0 ? (
            <ul className="max-h-64 space-y-2 overflow-auto text-xs">
              {events.map((event) => (
                <li key={event.id} className="rounded border border-stone-200 bg-white p-2">
                  <p className="font-medium text-stone-900">
                    {formatDateTime(event.occurred_at)} | {event.from_state ?? "-"} {"->"} {event.to_state}
                  </p>
                  <p className="text-stone-700">{event.event_type}</p>
                  <p className="text-stone-600">{event.event_message || "-"}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </article>
    </section>
  );
}
